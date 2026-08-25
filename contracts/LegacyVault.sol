// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/**
 * @title LegacyVault
 * @notice On-chain inheritance protocol ("dead man's switch") for BOT Chain.
 *
 * Each vault holds exactly ONE asset: either native BOT (`token ==
 * address(0)`) or a single ERC-20 such as USDT (chosen at creation and
 * immutable thereafter). All accounting (balance, pools, slices) is in that
 * asset's smallest unit.
 *
 * State machine per vault:
 *
 *   Active ──(timeout, anyone triggers)──▶ TriggerPending
 *   Active ◀──(guardian/owner cancels, or owner checkIn*)── TriggerPending
 *   TriggerPending ──(dispute window elapses, beneficiary claims t1)──▶ TrancheOneReleased
 *   TrancheOneReleased ──(owner checkIn*)──▶ Active            [rule R1]
 *   TrancheOneReleased ──(full checkInInterval passes after the
 *                          first tranche-1 claim with no owner
 *                          check-in, beneficiary claims final)──▶ FullyReleased
 *
 *   * checkIn during TriggerPending is intentionally NOT allowed; the owner
 *     uses cancelRelease there. checkIn revives a vault from
 *     TrancheOneReleased (R1): the countdown to final release is cancelled,
 *     the first tranche already paid out stays paid, and any UNCLAIMED
 *     tranche-1 slices are forfeited back into the vault.
 *
 * Payments are strictly pull-based: every beneficiary claims their own
 * slice. A reverting receiver can only hurt itself, never the vault or
 * other beneficiaries. Slices are computed from immutable pool snapshots
 * taken at the first claim of each phase, so payout amounts do not depend
 * on claim ordering.
 */
contract LegacyVault is ReentrancyGuard {
    // ------------------------------------------------------------------
    // Types
    // ------------------------------------------------------------------

    enum VaultStatus {
        Active,
        TriggerPending,
        TrancheOneReleased,
        FullyReleased
    }

    struct Beneficiary {
        address wallet;
        uint16 shareBps; // basis points of payouts (10000 = 100%)
    }

    struct Vault {
        address owner;
        address guardian; // may be address(0) => only owner can cancel
        address token; // asset held: address(0) = native BOT, else ERC-20
        uint256 balance; // asset units held (accounting mirror)
        Beneficiary[] beneficiaries;
        uint16 totalShareBps; // sum of shareBps (may be < 10000 if owner under-allocated)
        uint256 checkInInterval; // seconds
        uint256 lastCheckIn;
        uint256 disputeWindow; // seconds
        uint16 tranche1Percent; // 1..99
        uint256 triggeredAt; // 0 = not triggered
        uint256 tranche1ClaimedAt; // timestamp of first tranche-1 claim
        VaultStatus status;
        // Pull-payment pools (snapshotted once, then drained pro-rata)
        uint256 t1PoolTotal;
        uint256 t1PoolRemaining;
        uint256 finalPoolTotal;
        uint256 finalPoolRemaining;
    }

    // ------------------------------------------------------------------
    // Storage
    // ------------------------------------------------------------------

    uint256 public constant MIN_CHECKIN_INTERVAL = 60; // anti-griefing floor
    uint256 public constant MAX_BENEFICIARIES = 25;
    uint16 public constant BPS_DENOMINATOR = 10_000;

    uint256 private _nextVaultId = 1;

    mapping(uint256 => Vault) private _vaults;
    mapping(uint256 => mapping(address => bool)) private _isBeneficiaryOf;
    mapping(uint256 => mapping(address => bool)) private _claimedT1;
    mapping(uint256 => mapping(address => bool)) private _claimedFinal;

    mapping(address => uint256[]) private _vaultIdsByOwner;
    mapping(address => uint256[]) private _vaultIdsByBeneficiary; // append-only; may contain stale ids after edits

    // ------------------------------------------------------------------
    // Events
    // ------------------------------------------------------------------

    event VaultCreated(
        uint256 indexed vaultId,
        address indexed owner,
        address indexed guardian,
        uint256 amount,
        uint256 checkInInterval,
        uint256 disputeWindow,
        uint16 tranche1Percent
    );
    event CheckedIn(uint256 indexed vaultId, address indexed owner);
    event Deposited(uint256 indexed vaultId, address indexed owner, uint256 amount);
    event BeneficiaryUpdated(uint256 indexed vaultId);
    event GuardianChanged(uint256 indexed vaultId, address indexed oldGuardian, address indexed newGuardian);
    event ReleaseTriggered(uint256 indexed vaultId, uint256 triggeredAt);
    event ReleaseCancelled(uint256 indexed vaultId, address indexed by);
    event Tranche1Claimed(uint256 indexed vaultId, address indexed beneficiary, uint256 amount);
    event FinalClaimed(uint256 indexed vaultId, address indexed beneficiary, uint256 amount);

    // ------------------------------------------------------------------
    // Creation & funding
    // ------------------------------------------------------------------

    function createVault(
        address[] calldata beneficiaries,
        uint16[] calldata shares,
        address guardian,
        uint256 checkInInterval,
        uint256 disputeWindow,
        uint16 tranche1Percent,
        address asset,
        uint256 amount
    ) external payable nonReentrant returns (uint256 vaultId) {
        require(amount > 0, "LV: no deposit");
        require(beneficiaries.length == shares.length, "LV: length mismatch");
        require(beneficiaries.length > 0, "LV: no beneficiaries");
        require(beneficiaries.length <= MAX_BENEFICIARIES, "LV: too many beneficiaries");
        require(checkInInterval >= MIN_CHECKIN_INTERVAL, "LV: interval < 60s");
        require(tranche1Percent >= 1 && tranche1Percent <= 99, "LV: tranche1 % out of range");

        // Validate everything before any external call, so a revert can never
        // strand funds that were already pulled in.
        uint16 total = _validateShares(beneficiaries, shares);
        uint256 credited = _fund(asset, amount);

        vaultId = _nextVaultId++;
        Vault storage v = _vaults[vaultId];
        v.owner = msg.sender;
        v.guardian = guardian;
        v.token = asset;
        v.checkInInterval = checkInInterval;
        v.lastCheckIn = block.timestamp;
        v.disputeWindow = disputeWindow;
        v.tranche1Percent = tranche1Percent;
        v.status = VaultStatus.Active;
        v.totalShareBps = total;

        _storeBeneficiaries(vaultId, v, beneficiaries, shares);
        v.balance = credited;
        _vaultIdsByOwner[msg.sender].push(vaultId);

        emit VaultCreated(vaultId, msg.sender, guardian, credited, checkInInterval, disputeWindow, tranche1Percent);
    }

    /// @dev Writes the beneficiary list and its membership indexes.
    function _storeBeneficiaries(
        uint256 vaultId,
        Vault storage v,
        address[] calldata wallets,
        uint16[] calldata shares
    ) private {
        for (uint256 i = 0; i < wallets.length; ++i) {
            v.beneficiaries.push(Beneficiary({wallet: wallets[i], shareBps: shares[i]}));
            _isBeneficiaryOf[vaultId][wallets[i]] = true;
            _vaultIdsByBeneficiary[wallets[i]].push(vaultId);
        }
    }

    /// @dev Validates the beneficiary list; returns the share sum in bps.
    function _validateShares(
        address[] calldata beneficiaries,
        uint16[] calldata shares
    ) private pure returns (uint16 total) {
        for (uint256 i = 0; i < beneficiaries.length; ++i) {
            require(beneficiaries[i] != address(0), "LV: zero beneficiary");
            require(shares[i] > 0, "LV: zero share");
            for (uint256 j = 0; j < i; ++j) {
                require(beneficiaries[i] != beneficiaries[j], "LV: duplicate beneficiary");
            }
            unchecked {
                total += shares[i];
            }
        }
        require(total == BPS_DENOMINATOR, "LV: shares must sum to 10000 bps");
    }

    /// @dev Moves the initial funding into the contract; returns the units
    /// actually received (native BOT or ERC-20).
    function _fund(address asset, uint256 amount) private returns (uint256) {
        if (asset == address(0)) {
            require(msg.value == amount, "LV: value mismatch");
            return msg.value; // native stays in the contract
        }
        require(msg.value == 0, "LV: unexpected native value");
        return _pullToken(IERC20(asset), msg.sender, amount);
    }

    /// @notice Top up an existing vault. Only while Active. `amount` is in
    /// vault-asset units: for a token vault it is pulled via transferFrom
    /// (approve first); for a native vault it must equal msg.value.
    function deposit(uint256 vaultId, uint256 amount) external payable nonReentrant {
        Vault storage v = _requireOwned(vaultId);
        require(v.status == VaultStatus.Active, "LV: not active");
        require(amount > 0, "LV: zero deposit");

        uint256 credited;
        if (v.token == address(0)) {
            require(msg.value == amount, "LV: value mismatch");
            credited = msg.value;
        } else {
            require(msg.value == 0, "LV: unexpected native value");
            credited = _pullToken(IERC20(v.token), msg.sender, amount);
        }
        v.balance += credited;
        emit Deposited(vaultId, msg.sender, credited);
    }

    // ------------------------------------------------------------------
    // Liveness
    // ------------------------------------------------------------------

    /// @notice Heartbeat by the owner. Allowed in Active and, per rule R1,
    /// in TrancheOneReleased (revives the vault; unclaimed tranche-1 slices
    /// are forfeited). Not allowed during TriggerPending (use cancelRelease).
    function checkIn(uint256 vaultId) external {
        Vault storage v = _requireOwned(vaultId);

        if (v.status == VaultStatus.Active) {
            v.lastCheckIn = block.timestamp;
        } else if (v.status == VaultStatus.TrancheOneReleased) {
            // Revive: forfeit whatever tranche-1 slices were never claimed.
            v.status = VaultStatus.Active;
            v.lastCheckIn = block.timestamp;
            v.triggeredAt = 0;
            v.tranche1ClaimedAt = 0;
            v.t1PoolTotal = 0;
            v.t1PoolRemaining = 0;
            _resetT1Flags(vaultId, v);
        } else {
            revert("LV: checkIn not allowed in this state");
        }
        emit CheckedIn(vaultId, v.owner);
    }

    // ------------------------------------------------------------------
    // Beneficiary & guardian management (owner, Active only)
    // ------------------------------------------------------------------

    /// @dev Adds a beneficiary. Requires the resulting total allocation to
    /// stay within 10000 bps; temporarily under-allocated sums are fine
    /// because payouts are always proportional to the live total.
    function addBeneficiary(uint256 vaultId, address wallet, uint16 shareBps) external {        Vault storage v = _requireOwnedActive(vaultId);
        require(wallet != address(0), "LV: zero beneficiary");
        require(shareBps > 0, "LV: zero share");
        require(!_isBeneficiaryOf[vaultId][wallet], "LV: duplicate beneficiary");
        require(v.totalShareBps + shareBps <= BPS_DENOMINATOR, "LV: shares would exceed 100%");

        v.beneficiaries.push(Beneficiary({wallet: wallet, shareBps: shareBps}));
        _isBeneficiaryOf[vaultId][wallet] = true;
        unchecked {
            v.totalShareBps += shareBps;
        }
        _vaultIdsByBeneficiary[wallet].push(vaultId);
        emit BeneficiaryUpdated(vaultId);
    }

    /// @dev Removes a beneficiary and rescales the remaining shares so they
    /// sum to 10000 bps again (proportional up-scaling; rounding dust goes
    /// to the first remaining beneficiary).
    function removeBeneficiary(uint256 vaultId, address wallet) external {
        Vault storage v = _requireOwnedActive(vaultId);
        require(_isBeneficiaryOf[vaultId][wallet], "LV: not a beneficiary");
        require(v.beneficiaries.length > 1, "LV: last beneficiary");

        Beneficiary[] memory old = v.beneficiaries;
        delete v.beneficiaries;
        delete v.totalShareBps;

        uint256 remainingSum;
        for (uint256 i = 0; i < old.length; ++i) {
            if (old[i].wallet != wallet) remainingSum += old[i].shareBps;
        }

        uint256 distributed;
        for (uint256 i = 0; i < old.length; ++i) {
            if (old[i].wallet == wallet) continue;
            uint16 scaled =
                uint16((uint256(old[i].shareBps) * BPS_DENOMINATOR + remainingSum - 1) / remainingSum);
            v.beneficiaries.push(Beneficiary({wallet: old[i].wallet, shareBps: scaled}));
            distributed += scaled;
        }
        // Fix rounding drift on the first entry (bounded by beneficiary count).
        if (distributed != BPS_DENOMINATOR) {
            v.beneficiaries[0].shareBps = uint16(
                uint256(v.beneficiaries[0].shareBps) + BPS_DENOMINATOR - distributed
            );
        }
        v.totalShareBps = BPS_DENOMINATOR;
        _isBeneficiaryOf[vaultId][wallet] = false;
        emit BeneficiaryUpdated(vaultId);
    }

    /// @dev Replaces the entire beneficiary list. Shares act as relative
    /// weights: each must be nonzero and the sum may not exceed 10000 bps
    /// (under-allocation is allowed mid-management; payouts are always
    /// proportional to the live total, so nothing breaks). Use this to free
    /// up room before calling addBeneficiary.
    function updateShares(uint256 vaultId, address[] calldata wallets, uint16[] calldata shares) external {
        Vault storage v = _requireOwnedActive(vaultId);
        require(wallets.length == shares.length, "LV: length mismatch");
        require(wallets.length > 0, "LV: no beneficiaries");
        require(wallets.length <= MAX_BENEFICIARIES, "LV: too many beneficiaries");

        uint16 total;
        for (uint256 i = 0; i < wallets.length; ++i) {
            require(wallets[i] != address(0), "LV: zero beneficiary");
            require(shares[i] > 0 && shares[i] <= BPS_DENOMINATOR, "LV: invalid share");
            for (uint256 j = 0; j < i; ++j) {
                require(wallets[i] != wallets[j], "LV: duplicate beneficiary");
            }
            unchecked {
                total += shares[i];
            }
        }
        require(total <= BPS_DENOMINATOR, "LV: shares must not exceed 10000 bps");

        // Clear old membership flags, then write the new list.
        Beneficiary[] memory old = v.beneficiaries;
        for (uint256 i = 0; i < old.length; ++i) {
            _isBeneficiaryOf[vaultId][old[i].wallet] = false;
        }
        delete v.beneficiaries;
        for (uint256 i = 0; i < wallets.length; ++i) {
            v.beneficiaries.push(Beneficiary({wallet: wallets[i], shareBps: shares[i]}));
            _isBeneficiaryOf[vaultId][wallets[i]] = true;
            _vaultIdsByBeneficiary[wallets[i]].push(vaultId);
        }
        v.totalShareBps = total;
        emit BeneficiaryUpdated(vaultId);
    }

    function changeGuardian(uint256 vaultId, address newGuardian) external {
        Vault storage v = _requireOwnedActive(vaultId);
        emit GuardianChanged(vaultId, v.guardian, newGuardian);
        v.guardian = newGuardian;
    }

    // ------------------------------------------------------------------
    // Release lifecycle
    // ------------------------------------------------------------------

    /// @notice Permissionless: anyone may trigger a lapsed vault.
    function triggerRelease(uint256 vaultId) external {
        Vault storage v = _vaults[vaultId];
        require(v.owner != address(0), "LV: unknown vault");
        require(v.status == VaultStatus.Active, "LV: not active");
        require(block.timestamp > v.lastCheckIn + v.checkInInterval, "LV: not timed out");

        v.status = VaultStatus.TriggerPending;
        v.triggeredAt = block.timestamp;
        emit ReleaseTriggered(vaultId, v.triggeredAt);
    }

    /// @notice Guardian OR owner may cancel while the dispute window is open.
    function cancelRelease(uint256 vaultId) external {
        Vault storage v = _vaults[vaultId];
        require(v.owner != address(0), "LV: unknown vault");
        require(v.status == VaultStatus.TriggerPending, "LV: not pending");
        require(block.timestamp <= v.triggeredAt + v.disputeWindow, "LV: dispute window closed");
        require(msg.sender == v.owner || msg.sender == v.guardian, "LV: not owner/guardian");

        v.status = VaultStatus.Active;
        v.triggeredAt = 0;
        v.lastCheckIn = block.timestamp;
        emit ReleaseCancelled(vaultId, msg.sender);
    }

    /// @notice Beneficiary pulls their tranche-1 slice. First successful call
    /// snapshots the pool and starts the final-release clock.
    function claimTranche1(uint256 vaultId) external nonReentrant {
        Vault storage v = _vaults[vaultId];
        require(v.owner != address(0), "LV: unknown vault");
        require(
            v.status == VaultStatus.TriggerPending || v.status == VaultStatus.TrancheOneReleased,
            "LV: wrong status"
        );
        if (v.status == VaultStatus.TriggerPending) {
            require(block.timestamp > v.triggeredAt + v.disputeWindow, "LV: dispute window open");
        }
        require(_isBeneficiaryOf[vaultId][msg.sender], "LV: not a beneficiary");
        require(!_claimedT1[vaultId][msg.sender], "LV: already claimed t1");

        if (v.t1PoolTotal == 0) {
            uint256 pool = (v.balance * v.tranche1Percent) / 100;
            require(pool > 0, "LV: nothing to distribute");
            v.t1PoolTotal = pool;
            v.t1PoolRemaining = pool;
            v.tranche1ClaimedAt = block.timestamp;
            v.status = VaultStatus.TrancheOneReleased;
        }

        uint256 amount = _slice(v.totalShareBps, shareOf(vaultId, msg.sender), v.t1PoolTotal);
        require(amount > 0, "LV: slice rounds to zero");
        require(amount <= v.t1PoolRemaining, "LV: pool drained");
        require(amount <= v.balance, "LV: balance mismatch");

        // Effects before interactions.
        _claimedT1[vaultId][msg.sender] = true;
        v.t1PoolRemaining -= amount;
        v.balance -= amount;

        _payout(v, msg.sender, amount);
        emit Tranche1Claimed(vaultId, msg.sender, amount);
    }

    /// @notice Beneficiary pulls their final slice. Requires one full extra
    /// checkInInterval to have passed since the FIRST tranche-1 claim with no
    /// owner check-in (owner check-in revives the vault instead).
    function claimFinal(uint256 vaultId) external nonReentrant {
        Vault storage v = _vaults[vaultId];
        require(v.owner != address(0), "LV: unknown vault");
        require(v.status == VaultStatus.TrancheOneReleased || v.status == VaultStatus.FullyReleased,
            "LV: wrong status");
        require(_isBeneficiaryOf[vaultId][msg.sender], "LV: not a beneficiary");
        require(!_claimedFinal[vaultId][msg.sender], "LV: already claimed final");

        if (v.finalPoolTotal == 0) {
            require(
                block.timestamp >= v.tranche1ClaimedAt + v.checkInInterval,
                "LV: final delay not elapsed"
            );
            // Fold anything nobody bothered to claim from tranche 1.
            uint256 pool = v.balance + v.t1PoolRemaining;
            require(pool > 0, "LV: nothing to distribute");
            v.finalPoolTotal = pool;
            v.finalPoolRemaining = pool;
            v.t1PoolRemaining = 0;
            v.status = VaultStatus.FullyReleased;
        }

        uint256 amount = _slice(v.totalShareBps, shareOf(vaultId, msg.sender), v.finalPoolTotal);
        require(amount > 0, "LV: slice rounds to zero");
        require(amount <= v.finalPoolRemaining, "LV: pool drained");
        require(amount <= v.balance, "LV: balance mismatch");

        _claimedFinal[vaultId][msg.sender] = true;
        v.finalPoolRemaining -= amount;
        v.balance -= amount;

        _payout(v, msg.sender, amount);
        emit FinalClaimed(vaultId, msg.sender, amount);
    }

    // ------------------------------------------------------------------
    // Views
    // ------------------------------------------------------------------

    function vaultCount() external view returns (uint256) {
        return _nextVaultId - 1;
    }

    function getVault(
        uint256 vaultId
    )
        external
        view
        returns (
            address owner,
            address guardian,
            address token,
            uint256 balance,
            uint256 checkInInterval,
            uint256 lastCheckIn,
            uint256 disputeWindow,
            uint16 tranche1Percent,
            uint256 triggeredAt,
            uint256 tranche1ClaimedAt,
            VaultStatus status
        )
    {
        Vault storage v = _requireExists(vaultId);
        return (
            v.owner,
            v.guardian,
            v.token,
            v.balance,
            v.checkInInterval,
            v.lastCheckIn,
            v.disputeWindow,
            v.tranche1Percent,
            v.triggeredAt,
            v.tranche1ClaimedAt,
            v.status
        );
    }

    function getBeneficiaries(
        uint256 vaultId
    )
        external
        view
        returns (address[] memory wallets, uint16[] memory shares, bool[] memory claimedT1Flags, bool[] memory claimedFinalFlags)
    {
        Vault storage v = _requireExists(vaultId);
        uint256 n = v.beneficiaries.length;
        wallets = new address[](n);
        shares = new uint16[](n);
        claimedT1Flags = new bool[](n);
        claimedFinalFlags = new bool[](n);
        for (uint256 i = 0; i < n; ++i) {
            wallets[i] = v.beneficiaries[i].wallet;
            shares[i] = v.beneficiaries[i].shareBps;
            claimedT1Flags[i] = _claimedT1[vaultId][wallets[i]];
            claimedFinalFlags[i] = _claimedFinal[vaultId][wallets[i]];
        }
    }

    function isBeneficiary(uint256 vaultId, address wallet) external view returns (bool) {
        return _isBeneficiaryOf[vaultId][wallet];
    }

    function getUserVaultIds(address owner) external view returns (uint256[] memory) {
        return _vaultIdsByOwner[owner];
    }

    /// @dev Append-only index: ids whose beneficiary list was later edited
    /// may appear here even if the wallet is no longer included. Filter with
    /// `isBeneficiary` (the frontend does this automatically).
    function getVaultsByBeneficiary(address wallet) external view returns (uint256[] memory) {
        return _vaultIdsByBeneficiary[wallet];
    }

    /// @return Seconds until the vault can be triggered (0 if already due or not Active).
    function timeUntilTimeout(uint256 vaultId) external view returns (uint256) {
        Vault storage v = _requireExists(vaultId);
        if (v.status != VaultStatus.Active) return 0;
        uint256 deadline = v.lastCheckIn + v.checkInInterval;
        return block.timestamp >= deadline ? 0 : deadline - block.timestamp;
    }

    function shareOf(uint256 vaultId, address wallet) public view returns (uint16) {
        Vault storage v = _requireExists(vaultId);
        uint256 n = v.beneficiaries.length;
        for (uint256 i = 0; i < n; ++i) {
            if (v.beneficiaries[i].wallet == wallet) return v.beneficiaries[i].shareBps;
        }
        return 0;
    }

    /// @notice One-stop helper powering the beneficiary dashboard: whether
    /// `who` can currently pull each tranche, plus rough payout estimates.
    /// Estimates use current state and may shift slightly if others claim
    /// between this call and the transaction.
    function getClaimState(
        uint256 vaultId,
        address who
    )
        external
        view
        returns (bool canClaimT1, bool canClaimFinal, uint256 estimatedT1, uint256 estimatedFinal)
    {
        Vault storage v = _requireExists(vaultId);
        uint16 share = shareOf(vaultId, who);
        if (!_isBeneficiaryOf[vaultId][who] || share == 0) return (false, false, 0, 0);
        uint16 totalBps = v.totalShareBps;

        // --- tranche 1 ---
        if (
            !_claimedT1[vaultId][who] &&
            (v.status == VaultStatus.TriggerPending || v.status == VaultStatus.TrancheOneReleased)
        ) {
            bool windowOver = v.status != VaultStatus.TriggerPending ||
                block.timestamp > v.triggeredAt + v.disputeWindow;
            if (windowOver) {
                uint256 pool = v.t1PoolTotal != 0 ? v.t1PoolTotal : (v.balance * v.tranche1Percent) / 100;
                if (pool > 0) {
                    canClaimT1 = true;
                    estimatedT1 = (pool * share) / totalBps;
                }
            }
        }

        // --- final ---
        if (
            !_claimedFinal[vaultId][who] &&
            (v.status == VaultStatus.TrancheOneReleased || v.status == VaultStatus.FullyReleased)
        ) {
            bool delayOver = v.finalPoolTotal != 0 ||
                (v.tranche1ClaimedAt != 0 && block.timestamp >= v.tranche1ClaimedAt + v.checkInInterval);
            if (delayOver) {
                uint256 pool = v.finalPoolTotal != 0 ? v.finalPoolTotal : v.balance + v.t1PoolRemaining;
                if (pool > 0) {
                    canClaimFinal = true;
                    estimatedFinal = (pool * share) / totalBps;
                }
            }
        }
    }

    // ------------------------------------------------------------------
    // Internals
    // ------------------------------------------------------------------

    /// @dev Pull `amount` of an ERC-20 from `from`. Credited amount is
    /// measured by balance delta so fee-on-transfer tokens cannot corrupt
    /// the accounting mirror.
    function _pullToken(IERC20 token, address from, uint256 amount) private returns (uint256 credited) {
        uint256 before = token.balanceOf(address(this));
        SafeERC20.safeTransferFrom(token, from, address(this), amount);
        credited = token.balanceOf(address(this)) - before;
        require(credited > 0, "LV: token transfer failed");
    }

    /// @dev Send a payout in the vault's asset. Effects are already applied.
    function _payout(Vault storage v, address to, uint256 amount) private {
        if (v.token == address(0)) {
            (bool ok, ) = to.call{value: amount}("");
            require(ok, "LV: transfer failed");
        } else {
            SafeERC20.safeTransfer(IERC20(v.token), to, amount);
        }
    }

    /// @dev Payout slice for one beneficiary: proportional to their share
    /// relative to the live total (not to 10000), so under-allocated lists
    /// still distribute the full pool.
    function _slice(uint16 totalBps, uint16 shareBps, uint256 poolTotal) private pure returns (uint256) {
        return (poolTotal * shareBps) / totalBps;
    }

    function _resetT1Flags(uint256 vaultId, Vault storage v) private {
        for (uint256 i = 0; i < v.beneficiaries.length; ++i) {
            _claimedT1[vaultId][v.beneficiaries[i].wallet] = false;
        }
    }

    function _requireExists(uint256 vaultId) private view returns (Vault storage v) {
        v = _vaults[vaultId];
        require(v.owner != address(0), "LV: unknown vault");
    }

    function _requireOwned(uint256 vaultId) private view returns (Vault storage v) {
        v = _requireExists(vaultId);
        require(msg.sender == v.owner, "LV: not vault owner");
    }

    function _requireOwnedActive(uint256 vaultId) private view returns (Vault storage v) {
        v = _requireOwned(vaultId);
        require(v.status == VaultStatus.Active, "LV: not active");
    }

    /// @dev Direct sends are rejected; use createVault/deposit.
    receive() external payable {
        revert("LV: use deposit()");
    }
}

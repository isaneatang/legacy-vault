# Build Prompt: On-Chain Inheritance Vault ("Dead Man's Switch") for BOT Chain

Copy everything below this line into the other AI as your build instructions.

---

## Project Overview

Build a full-stack Web3 dApp called **"Legacy Vault"** (or similar — you may propose a better name), a decentralized inheritance/succession protocol deployed on **BOT Chain** (an EVM-compatible Layer 1). The core idea: a wallet owner deposits native BOT tokens into a smart contract vault. The owner must periodically "check in" (sign a transaction) to prove they're active. If they fail to check in before their configured timeout, the vault releases funds to their named beneficiaries in a graduated, disputable way — not an instant all-or-nothing dump.

This is an **RWA (Real World Asset) / Open Innovation** category project: it manages succession/control of real value based on real-world owner status, entirely via deterministic on-chain logic (no AI/LLM dependency, no oracles required for MVP).

Target: buildable in ~2 days. Prioritize a working, secure, well-tested core contract over feature bloat. Ship the MVP feature set below fully rather than a larger scope partially.

---

## Tech Stack

- **Smart contracts**: Solidity ^0.8.24, Hardhat, OpenZeppelin Contracts v5 (`Ownable`, `ReentrancyGuard`)
- **Network**: BOT Chain testnet first (get RPC URL, chain ID, and faucet from https://dev-docs.botchain.ai and https://faucet.botchain.ai/basic — do not guess these values, look them up or ask the user for them), then mainnet later. Configure Hardhat with both networks so switching is a one-line change.
- **Frontend**: Vanilla JS (HTML/CSS/JS) or React — your choice, but keep it lightweight. Use **Reown AppKit** (formerly WalletConnect) for wallet connection, and **ethers.js** or **viem** for contract calls.
- **No backend/database required** — all state reads come directly from the contract via view functions and events.

---

## Design Requirements

- **Theme**: "Grim vault" — a merger of BOT Chain's dark green minimalist identity and an eerie grim-reaper mood. Scary but tasteful: haunted-crypt minimalism, not Halloween kitsch. No cartoon skulls, no dripping-blood fonts, no clutter.
- **Background**: near-black (`#0A0F0D`) with a very subtle vignette or faint fog/mist texture at page edges; large sections should feel like standing in a dark tomb lit by green light.
- **Primary accent (spectral green)**: keep the BOT Chain green family — dark green `#0F3D2E`–`#1FAA6E` range for panels/borders, brighter toxic/spectral green (`#1FAA6E` and above, e.g. up to `#4ADE80`) for CTAs, active states, and glowing countdown numbers. Use a soft outer glow on interactive elements and live timers so they read as eerie lantern light.
- **Secondary accent (bone & ash)**: text in bone/off-white (`#E8F0EC`), secondary text in muted gray-green. Reserve a desaturated blood/ember red (e.g. `#7A1F1F`, brightened variant for hover) strictly for danger states: overdue vaults, triggered releases, final-claim warnings.
- **Typeface pairing**: clean sans-serif (Inter / system UI stack) for all body/UI text, paired with a gothic blackletter-style display font (e.g. UnifrakturMaguntia, Pirata One, or similar free Google Font) used *only* for the logo/brand wordmark and major page headings — this delivers the "grim reaper font" feel without hurting readability.
- **Iconography**: thin-line, monochrome icons only. A single restrained reaper/skull/keyhole motif may appear in the logo and empty states (e.g. "no vaults yet" shows a small hooded-figure glyph); never as decoration on cards or buttons.
- Generous whitespace, subtle borders/glow instead of heavy shadows. Avoid generic "crypto template" look — no purple/blue gradients, no cartoonish icons.
- Fully responsive, but desktop-first is fine for a demo.

---

## Smart Contract Spec

### Core concept: Vault struct

Each user can create **multiple independent vaults** (e.g., different timeout periods for different beneficiaries). Store as `mapping(uint256 => Vault)` with an incrementing `vaultId`, plus `mapping(address => uint256[])` to look up a user's vault IDs.

```solidity
struct Beneficiary {
    address wallet;
    uint16 sharePercent; // basis points out of 10000, or simple 0-100, your call — must sum to 100%
}

enum VaultStatus { Active, TrancheOneReleased, FullyReleased, Cancelled }

struct Vault {
    address owner;
    address guardian;          // single address, can cancel a triggered release
    uint256 balance;           // native BOT held
    Beneficiary[] beneficiaries;
    uint256 checkInInterval;   // seconds — time allowed between check-ins before timeout
    uint256 lastCheckIn;       // timestamp of last check-in
    uint256 disputeWindow;     // seconds — grace period after trigger where guardian/owner can cancel
    uint16 tranche1Percent;    // e.g. 25 — percent released in first tranche
    uint256 triggeredAt;       // timestamp timeout was first detected (0 if not triggered)
    VaultStatus status;
}
```

### Time flexibility (IMPORTANT)

All time values (`checkInInterval`, `disputeWindow`) are stored as **raw seconds** in the contract — no special units on-chain. The **frontend** is responsible for offering a friendly unit picker (seconds / minutes / hours / days / weeks / months / years) and converting to seconds before calling the contract. This lets the same contract be used for a 2-minute test vault during the demo and a 6-month real vault in production. Do not hardcode any minimum timeout in the contract beyond a sane floor (e.g., `>= 60 seconds`) to prevent zero-second griefing.

### Required functions

- `createVault(address[] beneficiaries, uint16[] shares, address guardian, uint256 checkInInterval, uint256 disputeWindow, uint16 tranche1Percent) payable returns (uint256 vaultId)`
  Validates shares sum to 100, requires `msg.value > 0`, sets `lastCheckIn = block.timestamp`.

- `checkIn(uint256 vaultId)` — only owner, only if `status == Active`. Resets `lastCheckIn = block.timestamp`. Also usable to reset a vault back to `Active` if it was `TrancheOneReleased` but the owner reappears before final release — decide and document the exact rule (recommended: once TrancheOneReleased, the first tranche is gone, but owner check-in cancels the countdown to tranche 2 and returns status to Active).

- `deposit(uint256 vaultId) payable` — owner can top up an existing vault.

- `addBeneficiary`, `removeBeneficiary`, `updateShares` — owner only, only while `status == Active`, must keep shares summing to 100.

- `changeGuardian(uint256 vaultId, address newGuardian)` — owner only.

- `triggerRelease(uint256 vaultId)` — **permissionless** (anyone can call, e.g. a beneficiary or a bot). Checks `block.timestamp > lastCheckIn + checkInInterval` and `status == Active`. Sets `triggeredAt = block.timestamp` and `status = TrancheOneReleased`-pending (i.e., mark as triggered but still inside the dispute window — model this clearly, e.g. a separate `triggered` bool plus `TrancheOneReleased` only after dispute window passes, or a `TriggerPending` status — pick clean state machine and document it).

- `cancelRelease(uint256 vaultId)` — callable by `guardian` OR `owner`, only while inside the dispute window after trigger. Resets `triggeredAt = 0`, `lastCheckIn = block.timestamp`, `status = Active`.

- `claimTranche1(uint256 vaultId)` — callable by any beneficiary, only after `disputeWindow` has passed since `triggeredAt` with no cancellation. Pays out `tranche1Percent` of balance split by each beneficiary's share, via **pull payment** (use `call` with checks-effects-interactions, protected by `ReentrancyGuard`). Sets `status = TrancheOneReleased`.

- `claimFinal(uint256 vaultId)` — callable by any beneficiary, only after a **second, longer confirmation period** has elapsed since tranche 1 release with no owner check-in (define this as e.g. `checkInInterval` again, or a separate `finalReleaseDelay` — your call, document it). Pays out remaining balance by share. Sets `status = FullyReleased`.

- `timeUntilTimeout(uint256 vaultId) view returns (uint256)` — seconds remaining before trigger is possible (0 if already past).

- `getVaultsByBeneficiary(address wallet) view returns (uint256[] vaultIds)` — needed for the "what can I claim" dashboard. Since beneficiaries aren't natively indexed this way, maintain a `mapping(address => uint256[])` updated whenever beneficiaries are added.

- `getVault(uint256 vaultId) view returns (...)` — full vault details for the frontend.

### Events

Emit for every state transition: `VaultCreated`, `CheckedIn`, `Deposited`, `BeneficiaryUpdated`, `GuardianChanged`, `ReleaseTriggered`, `ReleaseCancelled`, `Tranche1Claimed`, `FinalClaimed`. Frontend will use these to build an activity/history feed per vault (same spirit as an on-chain game log).

### Security requirements

- `ReentrancyGuard` on all functions that transfer funds.
- Checks-effects-interactions ordering everywhere.
- Use `call{value: amount}("")` with success check, not `transfer`/`send`.
- No `selfdestruct`, no upgradability needed for MVP (keep it simple/auditable — note in your pitch that immutability is a deliberate trust feature).
- Guard against integer issues with shares (use basis points if you want finer-grained splits than whole percent).
- Write Hardhat tests covering: normal check-in cycle, trigger + successful cancel by guardian, trigger + successful cancel by returning owner, full timeout → tranche1 claim → final claim, wrong-caller reverts (non-owner check-in, non-beneficiary claim), share-sum validation.

---

## Frontend Pages

1. **Dashboard ("My Vaults")** — after wallet connect, list all vaults the connected address owns. Each card shows: balance, status, countdown to next check-in deadline, quick "Check In" button. Button to "Create New Vault."

2. **Create Vault** — form with: deposit amount, beneficiary list (address + share %, add/remove rows, live sum validator), guardian address, check-in interval (number + unit dropdown: seconds/minutes/hours/days/weeks/months/years), dispute window (same unit picker), tranche 1 percent slider. Clear summary before submit ("If you don't check in for X, Y% releases after Z dispute window, remainder after...").

3. **Vault Detail (owner view)** — full state, countdown timer (live, updating client-side), check-in button, beneficiary/guardian edit forms (only enabled while Active), event history feed pulled from logs.

4. **Claimable Assets (beneficiary view)** — **this is important, build it carefully**: when a wallet connects, query `getVaultsByBeneficiary(address)` and show every vault where this wallet is a beneficiary. For each: vault owner, this wallet's share %, current status, and a clear countdown ("Time until you can claim tranche 1: ..." or "Time until final claim: ..." or "Claimable now" with a Claim button if unlocked). This is the wallet's personal "what am I owed and when" screen.

5. **Public Vault Watch page (optional, nice-to-have if time allows)** — read-only page at `/vault/:id`, viewable by anyone without connecting a wallet, showing status and countdown — mirrors a "spectator" view, useful for demo/trust transparency.

---

## Deliverables

- `contracts/LegacyVault.sol` + Hardhat config for BOT Chain testnet and mainnet
- Full test suite (`test/LegacyVault.test.js`)
- Deployment script with clear README on how to deploy/verify on BOT Chain explorer (https://scan.botchain.ai)
- Frontend app with the 4-5 pages above, dark green minimalist theme, Reown AppKit wallet connect
- README explaining: the problem, the architecture, the graduated-release + guardian-dispute mechanism, and how it's scalable to ERC-20 tokens in a future version (mention this explicitly as a stated roadmap item, even though MVP is native-BOT-only)

---

## Explicitly Out of Scope for MVP (mention as "future work" in README/pitch, do not build now)

- ERC-20 token support (native BOT only for now)
- Multiple guardians / multisig cancellation
- Any AI/LLM-based verification or notification layer
- Death-certificate/proof-of-death document verification
- Mobile app

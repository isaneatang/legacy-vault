# Legacy Vault ⚰️

> A dead man's switch for BOT Chain — an on-chain inheritance vault that releases
> your assets to your beneficiaries only when you stop showing up.

Built for the **RWA / Open Innovation** category on **BOT Chain** (EVM-compatible L1).
No oracles, no AI, no backend — pure deterministic on-chain logic.

---

## The problem

Crypto wealth dies with its keys. If something happens to you, your family cannot
reach your funds — and if nothing happens to you, no one should be able to take them.
Legacy Vault sits between those two worlds:

1. **You** deposit native BOT *or* an ERC-20 such as USDT into a vault and name
   beneficiaries (with % shares) and an optional guardian. Each vault holds
   exactly one asset, chosen at creation.
2. **You check in** periodically — one transaction proves you're alive.
3. **If you go silent** past your configured interval, *anyone* (a beneficiary, a
   bot, a friend) can permissionlessly trigger the release.
4. A **dispute window** follows: you or your guardian can cancel with one click.
5. After the window, beneficiaries pull a **first tranche** (e.g. 25%). Only after
   a second, longer silence does the remainder unlock.

The result is graduated, disputable succession — not an instant all-or-nothing dump.

## Architecture

```
┌─────────────────────────────┐        ┌──────────────────────────────┐
│  frontend/  (vanilla JS)    │        │  contracts/LegacyVault.sol   │
│  zero-dependency wallet     │◄──────►│  Solidity ^0.8.24 + OZ v5    │
│  module (EIP-6963) + ethers │  RPC   │  ReentrancyGuard pull-payouts│
│  v6, no backend             │        │  immutable, non-upgradable   │
└─────────────────────────────┘        └──────────────────────────────┘
```

- `contracts/LegacyVault.sol` — the entire protocol. Multiple vaults per user,
  full event history (`VaultCreated`, `CheckedIn`, `ReleaseTriggered`,
  `Tranche1Claimed`, …) that the frontend replays as an activity feed.
- `test/LegacyVault.test.js` — 30 Hardhat tests covering the check-in cycle,
  guardian/owner cancels, the full timeout → tranche-1 → final flow, wrong-caller
  reverts, share validation, and the revival rule.
- `scripts/deploy.js` — one-command deploy + deployment record in `deployments/`.
- `frontend/` — five pages served statically; all state comes from view calls and logs.

### State machine (per vault)

```
Active ──(timeout, anyone triggers)──▶ TriggerPending
TriggerPending ──(owner/guardian cancels within dispute window)──▶ Active
TriggerPending ──(dispute window elapses, beneficiary pulls)──▶ TrancheOneReleased
TrancheOneReleased ──(owner checks in again)──▶ Active   [rule R1]
TrancheOneReleased ──(full extra check-in interval of silence)──▶ FullyReleased
```

Documented rules worth knowing:

| Rule | Behaviour |
| --- | --- |
| Trigger | Permissionless — anyone may trigger a lapsed vault (beneficiaries shouldn't need to trust each other). |
| Dispute window | Guardian **or** owner cancels while open. Window length is owner-chosen (can be 0). |
| R1 — revival | Owner check-in during `TrancheOneReleased` returns the vault to `Active`. The first tranche already paid stays paid; unclaimed tranche-1 slices are forfeited back to the vault. |
| Final delay | One more full `checkInInterval` of silence after tranche-1 before the remainder unlocks. |
| Pull payments | Every beneficiary claims their own slice via `claim{value}` / `SafeERC20.safeTransfer` + checks-effects-interactions + `ReentrancyGuard`. A reverting receiver can never DoS other claimants. |
| Dual asset | Each vault is denominated in native BOT (`token = 0x0`) or a single ERC-20 (e.g. USDT) chosen at creation. Token deposits use `transferFrom` (approve first); credited amount is measured by balance delta so fee-on-transfer tokens can't corrupt accounting. |
| Pool snapshots | Tranche pools are snapshotted at the first claim of each phase — payout amounts don't depend on claim order. |
| Shares | Basis points (10000 = 100%), validated to sum exactly 10000 at creation. During management edits shares act as relative weights against the live total, so under-allocation is always safe. |

### Security posture

- Checks-effects-interactions everywhere; external calls last.
- OpenZeppelin v5 `ReentrancyGuard`; `call{value}` with success checks.
- No `selfdestruct`, no upgradeability, no admin key. **Immutability is deliberate:**
  a succession protocol you could silently rewrite is not one anyone should trust.
- Sane floors: check-in interval ≥ 60 s, ≤ 25 beneficiaries, tranche-1 between 1–99%.

## Quickstart

```bash
npm install

# run the test suite
npx hardhat test

# local demo node + deploy
npx hardhat node                      # terminal 1
npm run deploy:local                  # terminal 2
cp deployments/localhost.json address → paste into frontend/js/config.js

# serve the frontend
cd frontend && python3 -m http.server 8080
# open http://localhost:8080 (MetaMask → localhost:8545)
```

### Deploying to BOT Chain testnet

```bash
cp .env.example .env          # add DEPLOYER_PRIVATE_KEY (testnet-only key!)
# get testnet tBOT from https://faucet.botchain.ai/basic
npm run deploy:testnet
npx hardhat verify --network botTestnet <address>
```

Official network parameters (from [dev-docs.botchain.ai](https://dev-docs.botchain.ai/docs/Developers/json-rpc-endpoint/)):

| Network | Chain ID | RPC | Explorer | Faucet |
| --- | --- | --- | --- | --- |
| BOT Chain Testnet | `968` | `https://rpc.bohr.life` | https://scan.bohr.life | https://faucet.botchain.ai/basic |
| BOT Chain Mainnet | `677` | `https://rpc.botchain.ai` | https://scan.botchain.ai | — |

Switching networks is a one-line change (`--network botTestnet` ↔ `botMainnet`).

### Demo script (2-minute vault)

Create a vault with: interval **2 minutes**, dispute window **60 seconds**,
tranche-1 **25%**, two beneficiaries 50/50. Check in once, then wait it out:
trigger after 2 min, let the dispute lapse, claim tranche 1 from the beneficiary
wallet, wait another interval, claim final. The whole arc fits in ~5 minutes.

## Frontend pages

| Page | Purpose |
| --- | --- |
| `index.html` | **Landing** — the problem, how the vault lifecycle works in five steps, and why the design is trustworthy. No wallet needed. |
| `vaults.html` | **My Vaults** — cards per owned vault: balance, status, live countdown, quick check-in. |
| `create.html` | **Create Vault** — beneficiary rows with live %-sum validator, guardian, interval & dispute unit pickers (seconds→years), tranche-1 slider, plain-language summary before you sign. |
| `detail.html?vault=N` | Owner view — full state, contextual countdown, check-in / trigger / cancel actions, top-up, guardian rotation, beneficiary editor (Active only), replayed event history. |
| `claims.html` | **Claimable Assets** — every vault where the connected wallet is a beneficiary, with exact unlock countdowns and estimated payout amounts per claim. |
| `watch.html?vault=N` | Public read-only spectator view — no wallet required. |

### Wallet connection

- **Reown AppKit modal** (`@reown/appkit`): one polished default modal for
  everything — injected extensions (MetaMask, Rabby, Coinbase, OKX, Trust…),
  QR-based WalletConnect for mobile wallets, and proper deep-link handling on
  Android/iOS browsers. Loaded lazily from CDN; needs `WC_PROJECT_ID`
  (free from cloud.reown.com), injected via build-time env.
- **Zero-config fallback**: without a project id, the app falls back to a
  plain injected-wallet connection (desktop extensions only).
- **Account menu**: click the connected chip for the full address, copy,
  live balance, explorer link, network switcher and real disconnect.
- **Automatic network handling**: on connect (and before every write) the app
  tries `wallet_switchEthereumChain`, transparently adding BOT Chain if the
  wallet doesn't know it.

Theme: "grim vault" — tomb-dark near-black base, spectral-green glowing accents,
bone text, ember-red reserved for triggered/danger states, blackletter display
face for the brand and headings only.

## Roadmap (explicitly out of scope for MVP)

- Multiple guardians / multisig cancellation
- AI/LLM-based notification layer ("your owner has gone quiet…")
- Death-certificate / proof-of-death document verification
- Mobile app

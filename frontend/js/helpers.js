// Legacy Vault — ABI + pure formatting helpers.

export const UNIT_SECONDS = {
  seconds: 1,
  minutes: 60,
  hours: 3600,
  days: 86400,
  weeks: 604800,
  months: 2629800, // 30.4375 days
  years: 31557600, // 365.25 days
};

export const STATUS_NAMES = ["Active", "Trigger Pending", "Tranche 1 Released", "Fully Released"];
export const STATUS_CHIPS = ["st-active", "st-pending", "st-tranche", "st-released"];

export const LV_ABI = [
  // writes
  "function createVault(address[] beneficiaries, uint16[] shares, address guardian, uint256 checkInInterval, uint256 disputeWindow, uint16 tranche1Percent, address asset, uint256 amount) payable returns (uint256 vaultId)",
  "function deposit(uint256 vaultId, uint256 amount) payable",
  "function checkIn(uint256 vaultId)",
  "function triggerRelease(uint256 vaultId)",
  "function cancelRelease(uint256 vaultId)",
  "function claimTranche1(uint256 vaultId)",
  "function claimFinal(uint256 vaultId)",
  "function addBeneficiary(uint256 vaultId, address wallet, uint16 shareBps)",
  "function removeBeneficiary(uint256 vaultId, address wallet)",
  "function updateShares(uint256 vaultId, address[] wallets, uint16[] shares)",
  "function changeGuardian(uint256 vaultId, address newGuardian)",
  // reads
  "function getVault(uint256) view returns (address owner, address guardian, address token, uint256 balance, uint256 checkInInterval, uint256 lastCheckIn, uint256 disputeWindow, uint16 tranche1Percent, uint256 triggeredAt, uint256 tranche1ClaimedAt, uint8 status)",
  "function getBeneficiaries(uint256) view returns (address[] wallets, uint16[] shares, bool[] claimedT1, bool[] claimedFinal)",
  "function getClaimState(uint256, address) view returns (bool canClaimT1, bool canClaimFinal, uint256 estimatedT1, uint256 estimatedFinal)",
   "function isBeneficiary(uint256, address) view returns (bool)",
   "function shareOf(uint256, address) view returns (uint16)",
  "function getUserVaultIds(address) view returns (uint256[])",
  "function getVaultsByBeneficiary(address) view returns (uint256[])",
  "function timeUntilTimeout(uint256) view returns (uint256)",
  "function vaultCount() view returns (uint256)",
  // events
  "event VaultCreated(uint256 indexed vaultId, address indexed owner, address indexed guardian, uint256 amount, uint256 checkInInterval, uint256 disputeWindow, uint16 tranche1Percent)",
  "event CheckedIn(uint256 indexed vaultId, address indexed owner)",
  "event Deposited(uint256 indexed vaultId, address indexed owner, uint256 amount)",
  "event BeneficiaryUpdated(uint256 indexed vaultId)",
  "event GuardianChanged(uint256 indexed vaultId, address indexed oldGuardian, address indexed newGuardian)",
  "event ReleaseTriggered(uint256 indexed vaultId, uint256 triggeredAt)",
  "event ReleaseCancelled(uint256 indexed vaultId, address indexed by)",
  "event Tranche1Claimed(uint256 indexed vaultId, address indexed beneficiary, uint256 amount)",
  "event FinalClaimed(uint256 indexed vaultId, address indexed beneficiary, uint256 amount)",
];

/** Minimal ERC-20 surface: asset metadata + the approve/allowance dance. */
export const ERC20_ABI = [
  "function symbol() view returns (string)",
  "function decimals() view returns (uint8)",
  "function balanceOf(address) view returns (uint256)",
  "function allowance(address owner, address spender) view returns (uint256)",
  "function approve(address spender, uint256 amount) returns (bool)",
];

export const NATIVE_ADDRESS = "0x0000000000000000000000000000000000000000";

/* ---------------- formatting ---------------- */

export function shortAddr(a, size = 4) {
  if (!a) return "";
  return `${a.slice(0, 2 + size)}…${a.slice(-size)}`;
}

/** raw units → trimmed decimal string (decimals defaults to 18 / native). */
export function fmtAmt(wei, maxDecimals = 4, decimals = 18) {
  try {
    const val = Number(wei) / 10 ** Number(decimals || 18);
    const s = val.toLocaleString(undefined, { maximumFractionDigits: maxDecimals });
    return s;
  } catch {
    return String(wei);
  }
}

/** Live countdown form: "2d 03:14:07" / "05:12" / "0s". */
export function fmtDuration(sec) {
  sec = Math.max(0, Math.floor(sec));
  const d = Math.floor(sec / 86400);
  const h = Math.floor((sec % 86400) / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  const pad = (n) => String(n).padStart(2, "0");
  if (d > 0) return `${d}d ${pad(h)}:${pad(m)}:${pad(s)}`;
  if (h > 0) return `${pad(h)}:${pad(m)}:${pad(s)}`;
  if (m > 0) return `${m}m ${pad(s)}s`;
  return `${sec}s`;
}

/** Long human form: "6 months, 3 days". Used in the create-vault summary. */
export function fmtDurationLong(sec) {
  const units = [
    [31557600, "year"],
    [2629800, "month"],
    [604800, "week"],
    [86400, "day"],
    [3600, "hour"],
    [60, "minute"],
    [1, "second"],
  ];
  let rest = Math.max(0, Math.floor(sec));
  if (rest === 0) return "0 seconds";
  const parts = [];
  for (const [len, name] of units) {
    if (parts.length >= 2) break;
    const n = Math.floor(rest / len);
    if (n > 0) {
      parts.push(`${n} ${name}${n === 1 ? "" : "s"}`);
      rest -= n * len;
    }
  }
  return parts.join(", ");
}

/** Pick the friendliest unit+value pair for a select dropdown default. */
export function humanTime(sec) {
  const order = ["years", "months", "weeks", "days", "hours", "minutes"];
  for (const u of order) {
    if (sec % UNIT_SECONDS[u] === 0 && sec / UNIT_SECONDS[u] >= 1 && sec >= UNIT_SECONDS[u]) {
      return { unit: u.replace(/s$/, ""), value: sec / UNIT_SECONDS[u] };
    }
  }
  return { unit: "seconds", value: sec };
}

/** Timestamp (sec) → local datetime string. */
export function fmtTimestamp(ts) {
  if (!ts) return "unknown time";
  return new Date(Number(ts) * 1000).toLocaleString();
}

// Legacy Vault frontend configuration.
// After deploying, copy the address printed by scripts/deploy.js here
// (or see deployments/<network>.json).

window.LV_CONFIG = {
  // Default contract address. Replace with your deployment, or set per-chain below.
  // Matches the most recent local deployment (deployments/localhost.json).
  VAULT_ADDRESS: "0x0165878A594ca255338adfa4d48449f69242Eb8F",

  // Per-network overrides (lowercase chainId keys). Fill in after deploying
  // to BOT Chain testnet/mainnet.
  VAULT_ADDRESS_BY_CHAIN: {
    "968": "0x9A93Beb4F9E73ED6b6Cf8CB390A2C35AB8CdBEE4", // BOT Chain Testnet
    // "677": "0x...",   // BOT Chain Mainnet
  },

  // Optional: WalletConnect/Reown relay project id (free at https://cloud.reown.com).
  // When set, a "WalletConnect" option appears in the connect modal (QR + any
  // mobile wallet, even where deep links fail). Leave empty to disable.
  WC_PROJECT_ID: "",

  CHAINS: {
    "31337": { name: "Hardhat Local", explorer: "" },
    "968": { name: "BOT Chain Testnet", rpc: "https://rpc.bohr.life", explorer: "https://scan.bohr.life", faucet: "https://faucet.botchain.ai/basic" },
    "677": { name: "BOT Chain", rpc: "https://rpc.botchain.ai", explorer: "https://scan.botchain.ai" },
  },

  TOKEN_SYMBOL: "BOT",
};

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
    "968": "0x0f64E15F24D854C7D5098708bD5Ae62A47316A7f", // BOT Chain Testnet (dual-asset: BOT + USDT)
    // "677": "0x...",   // BOT Chain Mainnet
  },

  // WalletConnect/Reown relay project id. Injected at BUILD TIME from the
  // environment: set WC_PROJECT_ID in Vercel env vars, or in .env locally and
  // run `node scripts/gen-config.js`. The generated frontend/js/env.js
  // overrides this empty default.
  WC_PROJECT_ID: "",

  CHAINS: {
    "31337": { name: "Hardhat Local", explorer: "" },
    "968": { name: "BOT Chain Testnet", rpc: "https://rpc.bohr.life", explorer: "https://scan.bohr.life", faucet: "https://faucet.botchain.ai/basic" },
    "677": { name: "BOT Chain", rpc: "https://rpc.botchain.ai", explorer: "https://scan.botchain.ai" },
  },

  // Same-origin proxies for chain RPCs (see /api/* rewrites in vercel.json).
  // The RPCs send no CORS headers, so browser-direct reads fail for
  // logged-out visitors; the proxy makes them same-origin. Local dev without
  // a proxy automatically falls back to the absolute URLs.
  RPC_PROXY: {
    "https://rpc.bohr.life": "/api/rpc-testnet",
    "https://rpc.botchain.ai": "/api/rpc-mainnet",
  },

  TOKEN_SYMBOL: "BOT",

  // ERC-20 assets a vault can be denominated in, keyed by chainId
  // (lowercase addresses). Symbol/decimals verified on-chain (eth_call).
  TOKENS: {
    "968": {
      "0x75edc9335175fc0552d51d48439f229c10420fe3": { symbol: "USDT", decimals: 6 }, // BOT Chain Testnet
    },
    "677": {
      "0xababc7ddc03e501d190c676bf3d92ef0e6e87a3c": { symbol: "USDT", decimals: 6 }, // BOT Chain Mainnet
    },
  },
};

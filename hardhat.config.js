require("@nomicfoundation/hardhat-toolbox");

require("dotenv").config({ path: ".env" });

// Official BOT Chain network parameters (from https://dev-docs.botchain.ai/docs/Developers/json-rpc-endpoint/)
const BOT_MAINNET = {
  chainId: 677,
  rpc: "https://rpc.botchain.ai",
  explorer: "https://scan.botchain.ai",
};

const BOT_TESTNET = {
  chainId: 968,
  rpc: "https://rpc.bohr.life",
  explorer: "https://scan.bohr.life", // confirmed live testnet explorer (scan-testnet.botchain.ai does not resolve)
};

// NEVER put a real private key in this file. Put it in .env (see .env.example).
function deployerAccount(networkName) {
  const key = process.env.DEPLOYER_PRIVATE_KEY;
  if (!key) {
    console.warn(
      `[warn] DEPLOYER_PRIVATE_KEY not set - transactions on ${networkName} will fail.\n` +
        `       Get testnet tBOT from https://faucet.botchain.ai/basic`
    );
    return [];
  }
  return [key];
}

module.exports = {
  solidity: {
    version: "0.8.24",
    settings: {
      optimizer: { enabled: true, runs: 200 },
      evmVersion: "paris", // avoid PUSH0 in case of EVM-version quirks on sidechains
    },
  },
  networks: {
    hardhat: {
      chainId: 31337,
    },
    localhost: {
      url: "http://127.0.0.1:8545",
      chainId: 31337,
    },
    botTestnet: {
      url: BOT_TESTNET.rpc,
      chainId: BOT_TESTNET.chainId,
      accounts: deployerAccount("botTestnet"),
    },
    botMainnet: {
      url: BOT_MAINNET.rpc,
      chainId: BOT_MAINNET.chainId,
      accounts: deployerAccount("botMainnet"),
    },
  },
  etherscan: {
    apiKey: {
      botMainnet: process.env.EXPLORER_API_KEY || "NO_KEY",
      botTestnet: process.env.EXPLORER_API_KEY || "NO_KEY",
    },
    customChains: [
      {
        network: "botMainnet",
        chainId: BOT_MAINNET.chainId,
        urls: {
          apiURL: `${BOT_MAINNET.explorer}/api`,
          browserURL: BOT_MAINNET.explorer,
        },
      },
      {
        network: "botTestnet",
        chainId: BOT_TESTNET.chainId,
        urls: {
          apiURL: `${BOT_TESTNET.explorer}/api`,
          browserURL: BOT_TESTNET.explorer,
        },
      },
    ],
  },
};

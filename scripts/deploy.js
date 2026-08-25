const fs = require("fs");
const path = require("path");
const hre = require("hardhat");

const NETWORK_INFO = {
  botTestnet: { name: "BOT Chain Testnet", chainId: 968, rpc: "https://rpc.bohr.life", explorer: "https://scan-testnet.botchain.ai", faucet: "https://faucet.botchain.ai/basic" },
  botMainnet: { name: "BOT Chain Mainnet", chainId: 677, rpc: "https://rpc.botchain.ai", explorer: "https://scan.botchain.ai" },
};

async function main() {
  const network = hre.network.name;
  const [deployer] = await hre.ethers.getSigners();

  console.log(`\n=== Legacy Vault deployment ===`);
  console.log(`Network : ${network}`);
  console.log(`Deployer: ${await deployer.getAddress()}`);

  const balance = await hre.ethers.provider.getBalance(deployer);
  console.log(`Balance : ${hre.ethers.formatEther(balance)} native\n`);

  if (balance === 0n) {
    const info = NETWORK_INFO[network];
    throw new Error(
      `Deployer has no funds.${info?.faucet ? ` Get testnet tBOT from ${info.faucet}` : ""}`
    );
  }

  const Vault = await hre.ethers.getContractFactory("LegacyVault");
  const vault = await Vault.deploy();
  await vault.waitForDeployment();

  const address = await vault.getAddress();
  const receipt = await vault.deploymentTransaction().wait();

  console.log(`LegacyVault deployed to: ${address}`);
  console.log(`Tx hash: ${receipt.hash}`);

  // Persist deployment record for the frontend.
  const dir = path.join(__dirname, "..", "deployments");
  fs.mkdirSync(dir, { recursive: true });
  const record = {
    network,
    chainId: Number((await hre.ethers.provider.getNetwork()).chainId),
    address,
    txHash: receipt.hash,
    deployedAt: new Date().toISOString(),
    deployer: await deployer.getAddress(),
  };
  fs.writeFileSync(path.join(dir, `${network}.json`), JSON.stringify(record, null, 2));

  const explorer = NETWORK_INFO[network]?.explorer;
  if (explorer) {
    console.log(`\nView on explorer: ${explorer}/address/${address}`);
    console.log(`Verify with:\n  npx hardhat verify --network ${network} ${address}`);
  }
  console.log(`\nNext step: put this address in frontend/js/config.js (VAULT_ADDRESS).`);
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });

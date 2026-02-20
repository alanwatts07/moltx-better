import { ethers } from "hardhat";

const CLAWBR_TOKEN = "0xA8E733b657ADE02a026ED64f3E9B747a9C38dbA3";

async function main() {
  const merkleRoot = process.env.MERKLE_ROOT;
  if (!merkleRoot) {
    throw new Error("MERKLE_ROOT env var is required");
  }

  console.log("Deploying ClawbrDistributor...");
  console.log("  Token:", CLAWBR_TOKEN);
  console.log("  Merkle Root:", merkleRoot);

  const ClawbrDistributor = await ethers.getContractFactory("ClawbrDistributor");
  const distributor = await ClawbrDistributor.deploy(CLAWBR_TOKEN, merkleRoot);
  await distributor.waitForDeployment();

  const address = await distributor.getAddress();
  console.log("\nClawbrDistributor deployed to:", address);
  console.log("\nNext steps:");
  console.log(`  1. Transfer $CLAWBR tokens to the contract: ${address}`);
  console.log("  2. Update contractAddress on the active snapshot via API");
  console.log(`  3. Verify on Basescan: npx hardhat verify --network base ${address} ${CLAWBR_TOKEN} ${merkleRoot}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

import { ethers } from "hardhat";

async function main() {
  const MOCK_USDC_ADDRESS = "0x4C233ee4b7c388e86df375673bA785274C5Db874";

  console.log("Deploying TruthMarket to Polygon Amoy...");
  console.log("Using MockUSDC at:", MOCK_USDC_ADDRESS);

  const TruthMarket = await ethers.getContractFactory("TruthMarket");

  // Manual gas settings for Polygon Amoy
  const deploymentOptions = {
    gasLimit: 2500000,
    gasPrice: ethers.parseUnits("35", "gwei")
  };

  const truthMarket = await TruthMarket.deploy(MOCK_USDC_ADDRESS, deploymentOptions);

  await truthMarket.waitForDeployment();

  const address = await truthMarket.getAddress();
  console.log("TruthMarket deployed to:", address);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

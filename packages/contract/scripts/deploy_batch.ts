import { ethers } from "hardhat";

async function main() {
  const MOCK_USDC_ADDRESS = "0x98a0c5ECAdAB5351fD6c9B7D1D66D6359F0D3d58";

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

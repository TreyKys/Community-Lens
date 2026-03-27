import { ethers } from "hardhat";

async function main() {
  console.log("Deploying MockUSDC to Polygon Amoy...");

  const MockUSDC = await ethers.getContractFactory("MockUSDC");

  // Manual gas settings for Polygon Amoy
  const deploymentOptions = {
    gasLimit: 2500000,
    gasPrice: ethers.parseUnits("35", "gwei")
  };

  const mockUSDC = await MockUSDC.deploy(deploymentOptions);

  await mockUSDC.waitForDeployment();

  const address = await mockUSDC.getAddress();
  console.log("MockUSDC deployed to:", address);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

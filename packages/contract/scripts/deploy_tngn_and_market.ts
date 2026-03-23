import { ethers } from "hardhat";

async function main() {
  const [deployer] = await ethers.getSigners();
  console.log("Deploying contracts with the account:", deployer.address);

  // Deploy tNGN
  const TNGN = await ethers.getContractFactory("tNGN");
  const deploymentOptions = {
    gasLimit: 3000000,
    gasPrice: ethers.parseUnits("35", "gwei")
  };

  const tngn = await TNGN.deploy(deploymentOptions);
  await tngn.waitForDeployment();
  const tngnAddress = await tngn.getAddress();
  console.log("tNGN deployed to:", tngnAddress);

  // Deploy TruthMarket
  const TruthMarket = await ethers.getContractFactory("TruthMarket");
  // Set feeTreasury to deployer address for now
  const feeTreasuryAddress = deployer.address;
  const truthMarket = await TruthMarket.deploy(tngnAddress, feeTreasuryAddress, deploymentOptions);

  await truthMarket.waitForDeployment();

  const truthMarketAddress = await truthMarket.getAddress();
  console.log("TruthMarket deployed to:", truthMarketAddress);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

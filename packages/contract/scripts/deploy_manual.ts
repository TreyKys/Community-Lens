import { ethers } from "hardhat";
import * as dotenv from "dotenv";
import * as path from "path";

// Explicitly load .env from the current directory
dotenv.config({ path: path.resolve(__dirname, "../.env") });

async function main() {
  const mockUSDCAddress = "0xF6529aac808c3CA667117CA191da709695462764";
  const privateKey = process.env.PRIVATE_KEY;
  const alchemyKey = process.env.ALCHEMY_API_KEY;

  if (!privateKey) throw new Error("Private key not found in .env");
  if (!alchemyKey) throw new Error("Alchemy key not found in .env");

  // Hardcode the RPC URL to be sure
  const rpcUrl = `https://polygon-amoy.g.alchemy.com/v2/${alchemyKey}`;

  const provider = new ethers.JsonRpcProvider(rpcUrl);
  const wallet = new ethers.Wallet(privateKey, provider);

  console.log("Deploying with account:", wallet.address);

  try {
      const balance = await provider.getBalance(wallet.address);
      console.log("Account balance:", ethers.formatEther(balance));
  } catch (e) {
      console.log("Could not fetch balance, proceeding anyway...");
  }

  console.log("Deploying TruthMarket...");

  // Use the manual wallet signer
  const TruthMarket = await ethers.getContractFactory("TruthMarket", wallet);

  // Cost = 1,500,000 * 25 gwei = 0.0375 POL
  const truthMarket = await TruthMarket.deploy(mockUSDCAddress, {
    gasLimit: 1500000,
    gasPrice: 25000000000 // 25 gwei
  });

  console.log("Deployment transaction sent:", truthMarket.deploymentTransaction()?.hash);

  await truthMarket.waitForDeployment();

  console.log("TruthMarket deployed to:", await truthMarket.getAddress());
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

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

  console.log("Deploying (4th Try - Optimized) with account:", wallet.address);

  // Get current nonce to overwrite pending tx
  const nonce = await provider.getTransactionCount(wallet.address, "latest");
  console.log("Using Nonce:", nonce);

  console.log("Deploying TruthMarket...");

  // Use the manual wallet signer
  const TruthMarket = await ethers.getContractFactory("TruthMarket", wallet);

  // Cost = 2,500,000 * 35 gwei = 0.0875 POL (Balance is ~0.12 POL)

  const truthMarket = await TruthMarket.deploy(mockUSDCAddress, {
    gasLimit: 2500000,
    gasPrice: 35000000000, // 35 gwei
    nonce: nonce // Force overwrite
  });

  console.log("Deployment transaction sent:", truthMarket.deploymentTransaction()?.hash);

  await truthMarket.waitForDeployment();

  console.log("TruthMarket deployed to:", await truthMarket.getAddress());
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

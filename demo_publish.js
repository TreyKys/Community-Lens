import * as mockDkg from './mock_dkg.js';
import { analyzeClaim } from './analyzer.js';
import chalk from 'chalk';

const BAD_CLAIM = "The Lagos-Abuja Underwater Tunnel was completed in 2024.";
const WIKI_TRUTH = "There is no underwater tunnel between Lagos and Abuja. This is a common internet hoax.";

async function main() {
  console.log("🔍 Analyzing Claim...");
  const analysis = analyzeClaim(BAD_CLAIM, WIKI_TRUTH);

  const trustScore = analysis.reviewRating.ratingValue;
  console.log(`⚠️ Conflict Detected! Trust Score: ${trustScore}/100`);

  console.log("⛓️ Minting Truth Patch to DKG...");
  const assetId = await mockDkg.publish(analysis);

  console.log(chalk.green.bold(`✅ Truth Patch Minted! Asset ID: ${assetId}`));
}

main();

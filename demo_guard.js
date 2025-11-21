import * as mockDkg from './mock_dkg.js';
import chalk from 'chalk';
import fs from 'fs-extra';

/**
 * Simulates a chatbot agent asking a question.
 * @param {string} question - The question to ask the agent.
 */
async function askAgent(question) {
  console.log(chalk.blue(`\n🤖 Agent received: "${question}"`));
  console.log("🛡️ Checking DKG Firewall...");

  let assetId;
  try {
      assetId = await fs.readFile('latest_asset.txt', 'utf-8');
      assetId = assetId.trim();
  } catch (e) {
      console.log(chalk.yellow("⚠️ Warning: No latest_asset.txt found. Please run demo_publish.js first."));
      return;
  }

  console.log(chalk.gray(`   (Checking against Asset ID: ${assetId})`));

  const resolvedData = await mockDkg.resolve(assetId);

  if (!resolvedData) {
    console.log(chalk.red(`⛔ BLOCK: Could not resolve Asset ID: ${assetId}`));
    return;
  }

  const rating = parseInt(resolvedData.reviewRating.ratingValue, 10);
  console.log(`   Found Trust Score: ${rating}%`);

  if (rating < 40) {
    console.log(chalk.red.bold(`⛔ BLOCKED: Evidence asset ${assetId}`));
    console.log(chalk.red(`   Reason: Truth Score ${rating}% (Below Threshold)`));
    console.log(chalk.red(`   Agent refused to answer.`));
  } else {
    console.log(chalk.green("✅ PASSED. Answering question..."));
  }
}

// Example usage:
// Check if command line arg is provided
const question = process.argv[2] || "Is there a Lagos-Abuja Underwater Tunnel?";
askAgent(question);

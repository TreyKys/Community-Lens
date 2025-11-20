import * as mockDkg from './mock_dkg.js';
import chalk from 'chalk';

// IMPORTANT: Paste the Asset ID from the demo_publish.js script here
const BLOCKED_ASSET_ID = "PASTE_ASSET_ID_HERE";

/**
 * Simulates a chatbot agent asking a question.
 * @param {string} question - The question to ask the agent.
 */
async function askAgent(question) {
  console.log(`🤖 Agent received: "${question}"`);
  console.log("🛡️ Checking DKG Firewall...");

  if (BLOCKED_ASSET_ID === "PASTE_ASSET_ID_HERE") {
    console.log(chalk.yellow("⚠️ Warning: BLOCKED_ASSET_ID is not set. Please run demo_publish.js and paste the Asset ID into demo_guard.js."));
    return;
  }

  const resolvedData = await mockDkg.resolve(BLOCKED_ASSET_ID);

  if (!resolvedData) {
    console.log(chalk.red(`⛔ BLOCK: Could not resolve Asset ID: ${BLOCKED_ASSET_ID}`));
    return;
  }

  const rating = parseInt(resolvedData.reviewRating.ratingValue, 10);

  if (rating < 50) {
    console.log(chalk.red.bold(`⛔ BLOCK: Agent refused to answer. Reason: Flagged by Community Lens (Asset: ${BLOCKED_ASSET_ID}).`));
  } else {
    console.log(chalk.green("✅ Answer: According to my knowledge, the aformentioned tunnel does not exist."));
  }
}

// Example usage:
askAgent("Tell me about the Lagos-Abuja Underwater Tunnel.");

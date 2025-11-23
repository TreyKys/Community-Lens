#!/usr/bin/env node

import chalk from 'chalk';
import readline from 'readline';

// Mock Database of "Truth Patches" (In reality, this queries DKG)
const TRUTH_LEDGER = [
    {
        id: "did:dkg:otp:2043/0x8f2...",
        topic: "lagos tunnel",
        verdict: "FALSE",
        confidence: 98,
        reason: "Geographically impossible; Abuja is inland."
    },
    {
        id: "did:dkg:otp:2043/0x9a1...",
        topic: "malaria vaccine",
        verdict: "TRUE",
        confidence: 92,
        reason: "Supported by WHO and clinical trial data."
    }
];

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout
});

console.clear();
console.log(chalk.cyan.bold("\n🛡️  COMMUNITY LENS AGENT GUARD (CLI v1.0)"));
console.log(chalk.gray("Connecting to DKG... ") + chalk.green("CONNECTED"));
console.log(chalk.gray("Syncing Truth Patches... ") + chalk.green("SYNCED (2 Assets Loaded)\n"));

const checkGuard = (prompt) => {
    const lowerPrompt = prompt.toLowerCase();

    // Simple keyword matching for demo purposes
    const flaggedAsset = TRUTH_LEDGER.find(asset => lowerPrompt.includes(asset.topic));

    if (flaggedAsset) {
        if (flaggedAsset.verdict === 'FALSE') {
            console.log(chalk.red.bold("\n⛔ BLOCKED BY COMMUNITY LENS"));
            console.log(chalk.red(`   Asset ID: ${flaggedAsset.id}`));
            console.log(chalk.yellow(`   Reason: ${flaggedAsset.reason}`));
            console.log(chalk.gray(`   Confidence: ${flaggedAsset.confidence}%`));
            console.log(chalk.dim("\nAction: The prompt was intercepted before reaching the LLM.\n"));
            return true;
        } else {
            console.log(chalk.green.bold("\n✅ VERIFIED BY COMMUNITY LENS"));
            console.log(chalk.green(`   Asset ID: ${flaggedAsset.id}`));
            console.log(chalk.blue(`   Note: This topic has been fact-checked as TRUE.`));
            // Proceed...
            return false;
        }
    }
    return false;
};

const ask = () => {
    rl.question(chalk.white.bold("User Prompt > "), (prompt) => {
        if (prompt.toLowerCase() === 'exit') {
            rl.close();
            process.exit(0);
        }

        const blocked = checkGuard(prompt);

        if (!blocked) {
            console.log(chalk.blue("\n🤖 AI Assistant:"));
            console.log("   Processing your request... [Simulated LLM Output]\n");
        }

        ask();
    });
};

ask();

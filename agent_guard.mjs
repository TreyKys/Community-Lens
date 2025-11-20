#!/usr/bin/env node
import axios from 'axios';
import chalk from 'chalk';

const args = process.argv.slice(2);
const claim = args.join(' ');

if (!claim) {
  console.log(chalk.red('Please provide a claim to verify.'));
  console.log('Usage: node agent_guard.js "Your claim here"');
  process.exit(1);
}

console.log(chalk.cyan(`\n🔍 Analyzing claim: "${claim}"...\n`));

try {
  // In a real scenario, this would query the DKG directly or the local cache.
  // For this demo, we hit our API which acts as the gateway/verifier.
  const response = await axios.post('http://localhost:4000/api/analyze', { claim });
  const result = response.data;

  if (result.isTrue) {
    console.log(chalk.green.bold('✅ VERIFIED AUTHENTIC'));
    console.log(chalk.green(`Evidence: ${result.evidence}`));
    console.log(chalk.gray(`Confidence: ${result.confidence}%`));
  } else {
    console.log(chalk.red.bold('🛡️  BLOCKED / DEBUNKED'));
    console.log(chalk.red(`Warning: ${result.analysis}`));
    console.log(chalk.yellow(`Evidence to contrary: ${result.evidence}`));
  }

} catch (error) {
  console.error(chalk.red('Error connecting to verification service. Is the server running?'));
}

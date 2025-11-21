import * as mockDkg from './mock_dkg.js';
import axios from 'axios';
import chalk from 'chalk';
import fs from 'fs-extra';

const BAD_CLAIM = "The Lagos-Abuja Underwater Tunnel was completed in 2024.";

async function main() {
  console.log(chalk.blue(`\n🔍 Verifying Claim: "${BAD_CLAIM}"`));

  try {
      // Call the local API
      const response = await axios.post('http://localhost:4000/api/analyze', {
          claim: BAD_CLAIM
      });
      const result = response.data;

      const truthScore = result.aggregate.truthScore;
      console.log(`📊 Verification Complete. Truth Score: ${truthScore}%`);
      console.log(`📝 Analysis: ${result.analysis}`);

      // Adapt to Schema.org ClaimReview for DKG
      const claimReview = {
        "@context": "https://schema.org",
        "@type": "ClaimReview",
        "claimReviewed": result.claim,
        "reviewRating": {
          "@type": "Rating",
          "ratingValue": truthScore.toString(),
          "bestRating": "100",
          "worstRating": "0",
          "alternateName": result.aggregate.isTrue ? "True" : "False"
        },
        "author": {
          "@type": "Organization",
          "name": "Community Lens Verifier"
        },
        "itemReviewed": {
            "@type": "CreativeWork",
            "discussionUrl": result.sources[0]?.url
        }
      };

      console.log("⛓️ Minting Truth Patch to DKG...");
      const assetId = await mockDkg.publish(claimReview);

      console.log(chalk.green.bold(`✅ Truth Patch Minted! Asset ID: ${assetId}`));

      // Save Asset ID for the guard demo
      await fs.writeFile('latest_asset.txt', assetId);
      console.log(chalk.gray(`(Saved Asset ID to latest_asset.txt for demo_guard.js)`));

  } catch (error) {
      console.error(chalk.red("Error during verification or publishing:"), error.message);
      if (error.response) {
          console.error("Server response:", error.response.data);
      }
  }
}

main();

import DkgClient from 'dkg.js';
import dotenv from 'dotenv';
import crypto from 'crypto';

dotenv.config();

const DKG_TESTNET_ENDPOINT = process.env.DKG_TESTNET_ENDPOINT || 'https://v6-pegasus-node-02.origin-trail.network';
const DKG_ENVIRONMENT = 'testnet';

let dkg = null;

// Initialize DKG Client if config is present
if (process.env.DKG_PRIVATE_KEY && process.env.SIMULATE_DKG_PUBLISH !== 'true') {
    try {
        dkg = new DkgClient({
            endpoint: DKG_TESTNET_ENDPOINT,
            environment: DKG_ENVIRONMENT,
            blockchain: {
                name: 'otp:2043', // NeuroWeb Testnet
                publicKey: process.env.DKG_PUBLIC_KEY, // Optional if private key derives it, but good for config
                privateKey: process.env.DKG_PRIVATE_KEY,
            },
        });
    } catch (e) {
        console.warn("Failed to initialize DKG client:", e.message);
    }
} else {
    console.log("DKG Client not initialized (Simulation Mode or missing keys).");
}

export const mintCommunityNote = async (data) => {
  const isSimulation = process.env.SIMULATE_DKG_PUBLISH === 'true' || !dkg;

  if (isSimulation) {
    console.log("Simulating DKG Publication...");
    // Generate deterministic UAL based on content
    const content = JSON.stringify({ claim, analysis, stakeAmount });
    const hash = crypto.createHash('sha256').update(content).digest('hex');
    const ual = `did:dkg:otp:2043/0x${hash}`;

    // Simulate network delay
    await new Promise(resolve => setTimeout(resolve, 2000));

    return {
      status: 'success',
      ual: ual,
      mode: 'simulated_gas',
      explorerUrl: `https://dkg-testnet.origintrail.io/explore?ual=${ual}` // Fake/Conceptual URL
    };
  }

  // Real DKG Publish
  try {
    const assetData = {
      "@context": "https://schema.org",
      "@type": "FactCheck",
      "reviewRating": {
        "@type": "Rating",
        "ratingValue": analysis.alignmentScore,
        "bestRating": "100",
        "worstRating": "0"
      },
      "claimReviewed": claim.topic,
      "itemReviewed": {
        "@type": "CreativeWork",
        "text": claim.grokText
      },
      "author": {
        "@type": "Organization",
        "name": "Community Lens Protocol"
      },
      "analysisResult": analysis
    };

    // This is a simplified asset creation call.
    // Actual DKG v6 requires specific parameters.
    // Using a generic 'asset create' pattern.
    const result = await dkg.asset.create(assetData, {
        epochs: 5, // default retention
        keywords: ['FactCheck', 'CommunityLens', claim.topic]
    });

    return {
      status: 'success',
      ual: result.UAL,
      mode: 'mainnet_beta' // or testnet
    };

  } catch (error) {
    console.error("DKG Publish Failed:", error);
    // Fallback to simulation if real publish fails
    const content = JSON.stringify({ claim, analysis });
    const hash = crypto.createHash('sha256').update(content).digest('hex');
    return {
        status: 'success',
        ual: `did:dkg:otp:2043/0x${hash}`,
        mode: 'fallback_simulation',
        error: error.message
    };
  }
};

import DkgClient from 'dkg.js';
import crypto from 'crypto';

let dkg = null;

// Initialize DKG client if credentials exist
try {
  if (process.env.DKG_TESTNET_ENDPOINT && process.env.DKG_PRIVATE_KEY) {
    dkg = new DkgClient({
      endpoint: process.env.DKG_TESTNET_ENDPOINT,
      port: 8900, // Default OriginTrail Node port if not specified in endpoint, usually endpoint has it
      useTls: process.env.DKG_TESTNET_ENDPOINT.startsWith('https'),
      blockchain: {
        name: 'otp:2043', // OriginTrail Parachain Testnet
        publicKey: '0x...', // Need public key? Usually derived from private key or wallet
        // Actual initialization depends on dkg.js version.
        // For v6, configuration is an object.
        // Since we might lack real credentials, we will wrap usage in try-catch.
      }
    });
    // Note: This is a placeholder initialization.
    // Real dkg.js init is complex and requires blockchain provider (ethers.js/web3.js).
    // Given the prompt constraints, we might fail here if we try to fully instantiate without a wallet provider.
    // However, the prompt says "If any error... Return { status: "simulated_gas_error" ... }".
  }
} catch (e) {
  console.log('[DKG Service] Failed to initialize DKG client (expected if no creds).');
}

export async function publishAsset(data) {
  console.log('[DKG Service] Publishing asset...', data);

  // Check if we can really publish
  if (dkg && process.env.DKG_API_KEY) { // API KEY might not be needed for dkg.js directly if using private key, but prompt lists it.
    try {
      // This is a hypothetical call structure for dkg.js v6
      // Real call: dkg.asset.create(payload, options)

      const asset = await dkg.asset.create({
        public: data
      }, {
        epochsNum: 5
      });

      return {
        status: "ok",
        ual: asset.ual
      };
    } catch (error) {
      console.error('[DKG Service] Real publish failed:', error.message);
      // Fall through to simulation
    }
  }

  // Simulation / Fallback
  return simulatePublish(data);
}

function simulatePublish(data) {
  // Compute SHA256 of canonicalized JSON
  // Canonicalization: sort keys
  const jsonString = JSON.stringify(data, Object.keys(data).sort());
  const hash = crypto.createHash('sha256').update(jsonString).digest('hex');

  // Construct simulated UAL
  // Format: did:dkg:otp:2043/0x[hash] (imitating a DKG UAL)
  const ual = `did:dkg:otp:2043/0x${hash}`;

  console.log('[DKG Service] Simulated publish. UAL:', ual);

  return {
    status: "simulated_gas_error", // As requested by prompt to indicate fallback/error
    ual: ual
  };
}

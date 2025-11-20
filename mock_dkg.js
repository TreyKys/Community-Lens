import fs from 'fs-extra';
import { randomBytes } from 'crypto';

const LEDGER_FILE = './mock_ledger.json';

// Ensure the ledger file exists
async function initLedger() {
  try {
    await fs.readJson(LEDGER_FILE);
  } catch (error) {
    if (error.code === 'ENOENT') {
      await fs.writeJson(LEDGER_FILE, {});
    } else {
      throw error;
    }
  }
}

initLedger();

/**
 * Publishes data to the mock DKG.
 * @param {object} data - The JSON object to publish.
 * @returns {Promise<string>} The Asset ID of the published data.
 */
export async function publish(data) {
  console.log('Publishing to Mock DKG...');
  await new Promise(resolve => setTimeout(resolve, 2000));

  const assetId = `did:dkg:otp:2043/0x${randomBytes(32).toString('hex')}`;
  const ledger = await fs.readJson(LEDGER_FILE);
  ledger[assetId] = data;
  await fs.writeJson(LEDGER_FILE, ledger, { spaces: 2 });

  console.log(`Published with Asset ID: ${assetId}`);
  return assetId;
}

/**
 * Resolves an Asset ID from the mock DKG.
 * @param {string} assetId - The Asset ID to resolve.
 * @returns {Promise<object|null>} The data associated with the Asset ID, or null if not found.
 */
export async function resolve(assetId) {
  try {
    const ledger = await fs.readJson(LEDGER_FILE);
    return ledger[assetId] || null;
  } catch (error) {
    console.error('Error resolving asset:', error);
    return null;
  }
}

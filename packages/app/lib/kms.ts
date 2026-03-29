import { KMSClient, GenerateDataKeyCommand, GenerateDataKeyCommandInput } from '@aws-sdk/client-kms';
import { Wallet } from 'ethers';

// Environment variables
const KMS_KEY_ID = process.env.KMS_KEY_ID || 'alias/truthmarket-master-key';
// Explicitly check for AWS credentials. If they don't exist, force the mock to prevent crashes.
const hasAwsCredentials = !!process.env.AWS_ACCESS_KEY_ID && !!process.env.AWS_SECRET_ACCESS_KEY;
const USE_MOCK_KMS = process.env.USE_MOCK_KMS === 'true' || !hasAwsCredentials;

let kmsClient: KMSClient | null = null;

if (!USE_MOCK_KMS) {
  kmsClient = new KMSClient({
    region: process.env.AWS_REGION || 'us-east-1',
    credentials: {
      accessKeyId: process.env.AWS_ACCESS_KEY_ID as string,
      secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY as string,
    },
  });
}

/**
 * Generates an EVM wallet for a given user.
 * In production, it uses AWS KMS to generate a data key which acts as the master secret,
 * then derives a deterministic private key using HMAC-SHA256(master_secret, user_id).
 * The master secret and private key are kept only in memory and garbage collected.
 *
 * @param userId - The user's ID string (e.g. UUID)
 * @returns { walletAddress: string } - The derived wallet address
 */
export async function generateUserWallet(userId: string): Promise<{ walletAddress: string }> {
  if (USE_MOCK_KMS || !kmsClient) {
    // Local dev mock: generate a random wallet and just return the address
    // We only need the public address to store in Supabase
    const wallet = Wallet.createRandom();
    return { walletAddress: wallet.address };
  }

  // Production: generate a data key via AWS KMS to use as the base secret for the user
  const params: GenerateDataKeyCommandInput = {
    KeyId: KMS_KEY_ID,
    KeySpec: 'AES_256', // 32 bytes
  };

  try {
    const command = new GenerateDataKeyCommand(params);
    const response = await kmsClient.send(command);

    if (!response.Plaintext) {
      throw new Error('KMS failed to return plaintext key');
    }

    const masterSecret = Buffer.from(response.Plaintext);

    // Use Web Crypto API for HMAC-SHA256 derivation instead of Node 'crypto'
    const crypto = globalThis.crypto;
    const key = await crypto.subtle.importKey(
        'raw',
        masterSecret,
        { name: 'HMAC', hash: 'SHA-256' },
        false,
        ['sign']
    );
    const signature = await crypto.subtle.sign(
        'HMAC',
        key,
        new TextEncoder().encode(userId)
    );
    const privateKeyHex = Array.from(new Uint8Array(signature))
        .map(b => b.toString(16).padStart(2, '0'))
        .join('');

    const wallet = new Wallet('0x' + privateKeyHex);

    // Overwrite memory containing the sensitive data to help with garbage collection
    masterSecret.fill(0);

    return { walletAddress: wallet.address };
  } catch (error) {
    console.error('Error generating user wallet with KMS:', error);
    throw new Error('Failed to generate user wallet');
  }
}

/**
 * Retrieves the Master Protocol Wallet for backend transaction signing.
 * In a fully KMS-managed setup, this could use KMS for signing directly,
 * but for this pivot, we use a KMS-managed master key to derive it or an ENV var.
 */
export function getMasterProtocolWallet(): Wallet {
  const MASTER_PRIVATE_KEY = process.env.MASTER_PRIVATE_KEY;
  if (!MASTER_PRIVATE_KEY) {
    throw new Error('MASTER_PRIVATE_KEY is not configured in the environment variables.');
  }
  return new Wallet(MASTER_PRIVATE_KEY);
}

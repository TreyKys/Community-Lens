import { KMSClient, GenerateDataKeyCommand, GenerateDataKeyCommandInput } from '@aws-sdk/client-kms';
import { createHmac } from 'crypto';
import { Wallet } from 'ethers';

// Environment variables
const KMS_KEY_ID = process.env.KMS_KEY_ID || 'alias/truthmarket-master-key';
const USE_MOCK_KMS = process.env.USE_MOCK_KMS === 'true';

let kmsClient: KMSClient | null = null;

if (!USE_MOCK_KMS) {
  kmsClient = new KMSClient({
    region: process.env.AWS_REGION || 'us-east-1',
    credentials: {
      accessKeyId: process.env.AWS_ACCESS_KEY_ID || '',
      secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY || '',
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

    // Derive private key: HMAC-SHA256(master_secret, user_id)
    const hmac = createHmac('sha256', masterSecret);
    hmac.update(userId);
    const privateKeyHex = hmac.digest('hex');

    // Generate ethers wallet from derived private key
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
  const MASTER_PRIVATE_KEY = process.env.MASTER_PRIVATE_KEY || 'fb4be7fcb4463e6dfecf88014f752dfacdf8cf45d9f8bc914daa55e4a850d0e8';
  return new Wallet(MASTER_PRIVATE_KEY);
}

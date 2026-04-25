/**
 * lib/kms.ts
 * AWS KMS-based deterministic EVM wallet derivation.
 * Private keys are NEVER stored. Derived on-demand from the KMS master secret,
 * used for ~200ms, then garbage collected.
 *
 * Setup:
 *   1. Create an HMAC_SHA_256 Customer Master Key in AWS KMS
 *   2. Set AWS_KMS_KEY_ID, AWS_REGION, AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY in env
 *   3. IAM policy must include kms:GenerateMac on the CMK
 */

import { privateKeyToAccount } from 'viem/accounts';
import { createWalletClient, http } from 'viem';
import { polygon, polygonAmoy } from 'viem/chains';

const IS_PRODUCTION = process.env.NODE_ENV === 'production';
const CHAIN = IS_PRODUCTION ? polygon : polygonAmoy;
const RPC_URL = IS_PRODUCTION
  ? `https://polygon-mainnet.g.alchemy.com/v2/${process.env.NEXT_PUBLIC_ALCHEMY_KEY}`
  : `https://polygon-amoy.g.alchemy.com/v2/${process.env.NEXT_PUBLIC_ALCHEMY_KEY || ''}`;

/**
 * Derive a deterministic EVM wallet address for a given userId.
 * Returns ONLY the address — never the private key.
 */
export async function deriveWalletAddress(userId: string): Promise<string> {
  if (!process.env.AWS_KMS_KEY_ID) {
    // Development fallback — mock address deterministic from userId
    const mockAddr = `0x${Buffer.from(userId.replace(/-/g, '')).slice(0, 20).toString('hex').padStart(40, '0')}`;
    console.warn('[KMS] AWS_KMS_KEY_ID not set — using mock address:', mockAddr);
    return mockAddr;
  }

  try {
    const { KMSClient, GenerateMacCommand } = await import('@aws-sdk/client-kms');

    const kms = new KMSClient({
      region: process.env.AWS_REGION || 'eu-west-1',
      credentials: {
        accessKeyId: process.env.AWS_ACCESS_KEY_ID!,
        secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY!,
      },
    });

    const result = await kms.send(new GenerateMacCommand({
      KeyId: process.env.AWS_KMS_KEY_ID,
      Message: Buffer.from(userId),
      MacAlgorithm: 'HMAC_SHA_256',
    }));

    if (!result.Mac) throw new Error('KMS GenerateMac returned no data');

    // Use the 32-byte MAC as the private key
    const privateKeyHex = `0x${Buffer.from(result.Mac).slice(0, 32).toString('hex')}` as `0x${string}`;
    const account = privateKeyToAccount(privateKeyHex);

    // Return address only — private key is GC'd when this function returns
    return account.address;
  } catch (error) {
    console.error('[KMS] Failed to derive wallet address:', error);
    throw new Error('Wallet derivation failed. Check AWS KMS configuration.');
  }
}

/**
 * Sign and send a contract transaction using the KMS-derived admin wallet.
 * Used for: commitBetState, resolveMarket (on-chain), heartbeat.
 *
 * The admin wallet is derived from the special key 'admin_protocol_wallet'.
 * This is the Master Protocol Wallet that holds all tNGN on-chain.
 */
export async function signAdminTransaction(
  contractAddress: string,
  abi: any[],
  functionName: string,
  args: any[]
): Promise<string> {
  if (!process.env.AWS_KMS_KEY_ID) {
    console.warn('[KMS] Skipping on-chain tx — no AWS_KMS_KEY_ID set');
    return '0x_mock_tx_hash_no_kms_configured';
  }

  try {
    const { KMSClient, GenerateMacCommand } = await import('@aws-sdk/client-kms');

    const kms = new KMSClient({
      region: process.env.AWS_REGION || 'eu-west-1',
      credentials: {
        accessKeyId: process.env.AWS_ACCESS_KEY_ID!,
        secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY!,
      },
    });

    // Derive the admin signing key from a fixed seed
    const result = await kms.send(new GenerateMacCommand({
      KeyId: process.env.AWS_KMS_KEY_ID,
      Message: Buffer.from('truthmarket_admin_protocol_wallet_v1'),
      MacAlgorithm: 'HMAC_SHA_256',
    }));

    if (!result.Mac) throw new Error('KMS GenerateMac returned no data');

    const privateKeyHex = `0x${Buffer.from(result.Mac).slice(0, 32).toString('hex')}` as `0x${string}`;
    const account = privateKeyToAccount(privateKeyHex);

    const walletClient = createWalletClient({
      account,
      chain: CHAIN,
      transport: http(RPC_URL || undefined),
    });

    const txHash = await walletClient.writeContract({
      address: contractAddress as `0x${string}`,
      abi,
      functionName,
      args,
    });

    console.log(`[KMS] ${functionName} tx submitted: ${txHash}`);

    // Private key is GC'd here
    return txHash;
  } catch (error) {
    console.error(`[KMS] Failed to sign ${functionName} transaction:`, error);
    throw error;
  }
}

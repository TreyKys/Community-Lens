import { NextResponse } from 'next/server';
import crypto from 'crypto';
import { createPublicClient, createWalletClient, http, parseUnits } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { polygonAmoy } from 'viem/chains';
import { TNGN_ADDRESS, TNGN_ABI, SAFE_AMOY_GAS } from '@/lib/constants';
import { db } from '@/lib/firebaseAdmin';

export async function POST(req: Request) {
  try {
    const rawBody = await req.text();
    const signature = req.headers.get('x-paystack-signature');
    const secret = process.env.PAYSTACK_SECRET_KEY;

    if (!secret || !signature) {
      return NextResponse.json({ error: 'Missing secret or signature' }, { status: 400 });
    }

    // 1. HMAC SHA512 Verification
    const hash = crypto.createHmac('sha512', secret).update(rawBody).digest('hex');
    if (hash !== signature) {
      console.error('Paystack signature verification failed.');
      return NextResponse.json({ error: 'Unauthorized payload' }, { status: 400 });
    }

    const payload = JSON.parse(rawBody);

    // Only process successful charges
    if (payload.event !== 'charge.success') {
      return NextResponse.json({ status: 'ignored event' }, { status: 200 });
    }

    const { reference, amount, metadata } = payload.data;

    // We assume the user's wallet address was passed in the Paystack checkout metadata
    const userWalletAddress = metadata?.walletAddress;

    if (!userWalletAddress) {
      console.error('Missing wallet address in Paystack metadata.');
      return NextResponse.json({ error: 'Missing wallet metadata' }, { status: 400 });
    }

    // 2. Idempotency Check (Replay Attack Protection via Firestore)
    const txRef = db.collection('paystack_transactions').doc(reference);
    const doc = await txRef.get();

    if (doc.exists) {
      console.log(`Reference ${reference} already processed. Skipping.`);
      return NextResponse.json({ status: 'already processed' }, { status: 200 });
    }

    // Mark as processed immediately to prevent race conditions
    await txRef.set({
        processedAt: new Date().toISOString(),
        amount: amount,
        walletAddress: userWalletAddress,
        status: 'pending_mint'
    });

    // 3. Server-Side Mint Execution
    // Convert kobo to standard NGN
    const amountInNGN = amount / 100;
    // Parse to 18 decimals for the ERC-20 token
    const amountToMint = parseUnits(amountInNGN.toString(), 18);

    if (!process.env.PRIVATE_KEY) {
      throw new Error('Server PRIVATE_KEY not configured.');
    }

    const account = privateKeyToAccount(`0x${process.env.PRIVATE_KEY.replace('0x', '')}`);

    // Fallback to Alchemy RPC if NEXT_PUBLIC_ALCHEMY_KEY is available
    const rpcUrl = process.env.NEXT_PUBLIC_ALCHEMY_KEY
        ? `https://polygon-amoy.g.alchemy.com/v2/${process.env.NEXT_PUBLIC_ALCHEMY_KEY}`
        : 'https://rpc-amoy.polygon.technology/';

    const publicClient = createPublicClient({
      chain: polygonAmoy,
      transport: http(rpcUrl),
    });

    const walletClient = createWalletClient({
      account,
      chain: polygonAmoy,
      transport: http(rpcUrl),
    });

    console.log(`Minting ${amountInNGN} tNGN to ${userWalletAddress} (Ref: ${reference})...`);

    const { request } = await publicClient.simulateContract({
      address: TNGN_ADDRESS,
      abi: TNGN_ABI,
      functionName: 'mint',
      args: [userWalletAddress, amountToMint],
      account,
    });

    // Execute Mint
    // @ts-expect-error viem typing mismatch with manual gas overrides
    const txHash = await walletClient.writeContract({
        ...request,
        ...SAFE_AMOY_GAS,
    });

    console.log(`Mint successful! Tx Hash: ${txHash}`);

    // Update status
    await txRef.update({
        status: 'completed',
        txHash: txHash
    });

    return NextResponse.json({ status: 'success', txHash }, { status: 200 });

  } catch (error: unknown) {
    console.error('Paystack webhook error:', error);
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
  }
}

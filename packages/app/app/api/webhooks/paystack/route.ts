import { NextResponse } from 'next/server';
import crypto from 'crypto';
import { createPublicClient, createWalletClient, http, parseUnits } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { polygonAmoy } from 'viem/chains';
import { TNGN_ADDRESS, TNGN_ABI, SAFE_AMOY_GAS_NO_LIMIT } from '@/lib/constants';
import { supabase } from '@/lib/supabase';

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

    // 2. Idempotency Check (Replay Attack Protection via Supabase)
    const { data: existingTx } = await supabase
      .from('paystack_transactions')
      .select('reference')
      .eq('reference', reference)
      .single();

    if (existingTx) {
      console.log(`Reference ${reference} already processed. Skipping.`);
      return NextResponse.json({ status: 'already processed' }, { status: 200 });
    }

    // Mark as processed immediately to prevent race conditions
    const { error: insertError } = await supabase
      .from('paystack_transactions')
      .insert({
        reference: reference,
        processed_at: new Date().toISOString(),
        amount: amount,
        wallet_address: userWalletAddress,
        status: 'pending_mint'
      });

    if (insertError) {
      console.error('Failed to insert transaction into Supabase:', insertError);
      return NextResponse.json({ error: 'Database error' }, { status: 500 });
    }

    // 3. Server-Side Mint Execution
    // Convert kobo to standard NGN
    const amountInNGN = amount / 100;

    // Frictional 1% conversion buffer
    const amountToMintNGN = amountInNGN * 0.99;
    const bonusAmountNGN = amountInNGN * 0.01;

    // Parse to 18 decimals for the ERC-20 token
    const amountToMint = parseUnits(amountToMintNGN.toString(), 18);

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

    // Execute Mint with 1.5M Gas Buffer
    // @ts-expect-error viem typing mismatch with manual gas overrides
    const txHash = await walletClient.writeContract({
        ...request,
        gas: BigInt(1500000), // 1.5M Gas limit to prevent OOG
        ...SAFE_AMOY_GAS_NO_LIMIT,
    });

    console.log(`Mint successful! Tx Hash: ${txHash}`);

    // Update status
    await supabase
      .from('paystack_transactions')
      .update({
        status: 'completed',
        tx_hash: txHash,
        frictional_amount: amountToMintNGN,
        bonus_credited: bonusAmountNGN,
      })
      .eq('reference', reference);

    // Also track the user's bonus balance explicitly if they have an active user profile
    try {
        const normalizedAddress = userWalletAddress.toLowerCase();
        const { data: userData, error: userError } = await supabase
            .from('users')
            .select('bonus_balance')
            .eq('walletAddress', normalizedAddress)
            .single();

        if (userError && userError.code !== 'PGRST116') {
             // PGRST116 means no rows returned (which is fine, user doesn't exist)
             throw userError;
        }

        if (userData) {
            const currentBonus = userData.bonus_balance || 0;
            await supabase
                .from('users')
                .update({ bonus_balance: currentBonus + bonusAmountNGN })
                .eq('walletAddress', normalizedAddress);
            console.log(`Credited ${bonusAmountNGN} bonus to user ${userWalletAddress} (Supabase)`);
        } else {
            // Create user profile if they don't exist yet but received a deposit
            await supabase
                .from('users')
                .insert({
                    walletAddress: normalizedAddress,
                    bonus_balance: bonusAmountNGN,
                    created_at: new Date().toISOString()
                });
            console.log(`Created new profile with ${bonusAmountNGN} bonus for user ${userWalletAddress} (Supabase)`);
        }
    } catch (e) {
        console.error('Failed to credit user bonus balance in Supabase:', e);
        // Not throwing to avoid rolling back the Paystack success
    }

    return NextResponse.json({ status: 'success', txHash, bonusAdded: bonusAmountNGN }, { status: 200 });

  } catch (error: unknown) {
    console.error('Paystack webhook error:', error);
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
  }
}

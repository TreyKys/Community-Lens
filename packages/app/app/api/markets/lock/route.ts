import { NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import crypto from 'crypto';

const supabaseAdmin = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL || 'https://build-dummy.supabase.co',
  process.env.SUPABASE_SERVICE_ROLE_KEY || 'build-dummy-key'
);

// Compute a Merkle root from an array of bet records.
// Each leaf = SHA256(betId + userId + marketId + outcomeIndex + netStake)
function buildMerkleRoot(bets: any[]): string {
  if (bets.length === 0) return crypto.createHash('sha256').update('empty').digest('hex');

  // Build leaf hashes
  let leaves = bets.map((bet) =>
    crypto
      .createHash('sha256')
      .update(`${bet.id}:${bet.user_id}:${bet.market_id}:${bet.outcome_index}:${bet.net_stake_tngn}`)
      .digest('hex')
  );

  // Build the tree upward until we have one root
  while (leaves.length > 1) {
    const nextLevel: string[] = [];
    for (let i = 0; i < leaves.length; i += 2) {
      const left = leaves[i];
      const right = leaves[i + 1] || left; // duplicate last leaf if odd count
      nextLevel.push(
        crypto.createHash('sha256').update(left + right).digest('hex')
      );
    }
    leaves = nextLevel;
  }

  return leaves[0];
}

// This endpoint is called by an Inngest job (or cron) exactly when a market's
// closes_at time is reached. It:
// 1. Fetches all bets for the market
// 2. Computes the Merkle root
// 3. Stores it in Supabase
// 4. TODO: Publishes to Polygon via the admin wallet (KMS signing)
export async function POST(request: Request) {
  try {
    // Secure this endpoint — only callable by internal cron / Inngest
    const cronSecret = request.headers.get('x-cron-secret');
    if (cronSecret !== process.env.CRON_SECRET) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const { marketId } = await request.json();
    if (!marketId) {
      return NextResponse.json({ error: 'Missing marketId' }, { status: 400 });
    }

    // 1. Verify market exists and is still open
    const { data: market, error: marketError } = await supabaseAdmin
      .from('markets')
      .select('id, status, closes_at')
      .eq('id', marketId)
      .single();

    if (marketError || !market) {
      return NextResponse.json({ error: 'Market not found' }, { status: 404 });
    }

    if (market.status !== 'open') {
      return NextResponse.json({ error: 'Market already locked or resolved' }, { status: 400 });
    }

    // 2. Lock the market immediately — no more bets accepted
    await supabaseAdmin
      .from('markets')
      .update({ status: 'locked' })
      .eq('id', marketId);

    // 3. Fetch ALL bets for this market
    const { data: bets, error: betsError } = await supabaseAdmin
      .from('user_bets')
      .select('id, user_id, market_id, outcome_index, net_stake_tngn')
      .eq('market_id', marketId)
      .eq('status', 'active');

    if (betsError) {
      console.error('Failed to fetch bets for Merkle commit:', betsError);
      return NextResponse.json({ error: 'Failed to fetch bets' }, { status: 500 });
    }

    // 4. Compute Merkle root
    const merkleRoot = buildMerkleRoot(bets || []);

    // 5. Store the commit in Supabase
    const { error: commitError } = await supabaseAdmin
      .from('merkle_commits')
      .insert({
        market_id: marketId,
        root_hash: merkleRoot,
        bet_count: bets?.length || 0,
        committed_at: new Date().toISOString(),
        polygon_tx_hash: null, // Updated below once on-chain tx is confirmed
      });

    if (commitError) {
      console.error('Failed to store Merkle commit:', commitError);
      return NextResponse.json({ error: 'Failed to store commit' }, { status: 500 });
    }

    // 6. Update market with Merkle root
    await supabaseAdmin
      .from('markets')
      .update({ merkle_root: merkleRoot })
      .eq('id', marketId);

    // ---------------------------------------------------------------
    // PHASE 3 TODO: Publish the Merkle root to Polygon via KMS signing.
    // Replace the mock below with:
    //
    //   import { KMSClient, GenerateMacCommand } from "@aws-sdk/client-kms";
    //   import { createWalletClient, http } from 'viem';
    //   import { polygon } from 'viem/chains';
    //
    //   const kms = new KMSClient({ region: process.env.AWS_REGION });
    //   // Derive admin signing key from KMS master secret
    //   const mac = await kms.send(new GenerateMacCommand({
    //     KeyId: process.env.AWS_KMS_KEY_ID,
    //     Message: Buffer.from('admin_signer'),
    //     MacAlgorithm: 'HMAC_SHA_256',
    //   }));
    //
    //   const walletClient = createWalletClient({ ... });
    //   const txHash = await walletClient.writeContract({
    //     address: TRUTH_MARKET_CONTRACT,
    //     abi: TRUTH_MARKET_ABI,
    //     functionName: 'commitBetState',
    //     args: [BigInt(marketId), `0x${merkleRoot}`],
    //   });
    //
    //   await supabaseAdmin.from('merkle_commits')
    //     .update({ polygon_tx_hash: txHash })
    //     .eq('market_id', marketId);
    // ---------------------------------------------------------------

    console.log(`Market ${marketId} locked. Merkle root: ${merkleRoot} (${bets?.length || 0} bets)`);

    return NextResponse.json({
      success: true,
      marketId,
      merkleRoot,
      betCount: bets?.length || 0,
    }, { status: 200 });

  } catch (error: any) {
    console.error('Market lock error:', error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}

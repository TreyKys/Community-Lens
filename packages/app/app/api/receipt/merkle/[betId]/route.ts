import { NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import crypto from 'crypto';

const supabaseAdmin = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

function hashLeaf(bet: any): string {
  return crypto
    .createHash('sha256')
    .update(`${bet.id}:${bet.user_id}:${bet.market_id}:${bet.outcome_index}:${bet.net_stake_tngn}`)
    .digest('hex');
}

function buildMerkleProof(leaves: string[], targetIndex: number): string[] {
  const proof: string[] = [];
  let index = targetIndex;
  let level = [...leaves];

  while (level.length > 1) {
    const nextLevel: string[] = [];
    for (let i = 0; i < level.length; i += 2) {
      const left = level[i];
      const right = level[i + 1] || left;
      if (i === index || i + 1 === index) {
        // sibling is the proof element
        proof.push(i === index ? right : left);
      }
      nextLevel.push(
        crypto.createHash('sha256').update(left + right).digest('hex')
      );
    }
    index = Math.floor(index / 2);
    level = nextLevel;
  }

  return proof;
}

export async function GET(
  request: Request,
  { params }: { params: { betId: string } }
) {
  try {
    const authHeader = request.headers.get('Authorization');
    if (!authHeader) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

    const token = authHeader.replace('Bearer ', '');
    const { data: { user }, error: authError } = await supabaseAdmin.auth.getUser(token);
    if (authError || !user) return NextResponse.json({ error: 'Invalid session' }, { status: 401 });

    const { betId } = params;

    // Fetch the specific bet
    const { data: bet, error: betError } = await supabaseAdmin
      .from('user_bets')
      .select('*, markets(question, options, merkle_root, status, on_chain_market_id)')
      .eq('id', betId)
      .eq('user_id', user.id)
      .single();

    if (betError || !bet) {
      return NextResponse.json({ error: 'Bet not found' }, { status: 404 });
    }

    if (!bet.markets?.merkle_root) {
      return NextResponse.json({
        error: 'This market has not been locked yet. Receipt available after betting closes.'
      }, { status: 400 });
    }

    // Fetch all bets for this market to rebuild the tree
    const { data: allBets } = await supabaseAdmin
      .from('user_bets')
      .select('id, user_id, market_id, outcome_index, net_stake_tngn')
      .eq('market_id', bet.market_id)
      .eq('status', 'active')
      .order('placed_at', { ascending: true });

    const betsArray = allBets || [];
    const leaves = betsArray.map(hashLeaf);
    const targetIndex = betsArray.findIndex(b => b.id === betId);

    if (targetIndex === -1) {
      return NextResponse.json({ error: 'Bet not found in market tree' }, { status: 404 });
    }

    const proof = buildMerkleProof(leaves, targetIndex);

    // Fetch on-chain commit record
    const { data: commit } = await supabaseAdmin
      .from('merkle_commits')
      .select('polygon_tx_hash, committed_at')
      .eq('market_id', bet.market_id)
      .single();

    const options = bet.markets?.options as string[];
    const receipt = {
      version: '1.0',
      generated_at: new Date().toISOString(),
      market_id: bet.market_id,
      market_question: bet.markets?.question,
      outcome_predicted: options?.[bet.outcome_index] || `Option ${bet.outcome_index}`,
      bet_id: betId,
      user_id: user.id,
      outcome_index: bet.outcome_index,
      stake_tngn: bet.stake_tngn,
      net_stake_tngn: bet.net_stake_tngn,
      payout_tngn: bet.payout_tngn || null,
      bet_status: bet.status,
      placed_at: bet.placed_at,
      merkle_root: bet.markets?.merkle_root,
      merkle_proof: proof,
      on_chain_commit: {
        polygon_tx_hash: commit?.polygon_tx_hash || null,
        committed_at: commit?.committed_at || null,
      },
      contract_address: process.env.NEXT_PUBLIC_TRUTH_MARKET_ADDRESS || null,
      instructions:
        'If TruthMarket is unreachable, visit polygonscan.com, find the contract address above, ' +
        'call emergencyWithdraw() with your merkle_proof and net_stake_tngn value. ' +
        'This is cryptographically guaranteed — no human approval needed.',
    };

    return NextResponse.json(receipt);
  } catch (error: any) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}

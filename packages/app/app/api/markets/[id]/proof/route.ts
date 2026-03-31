import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { MerkleTree } from 'merkletreejs';
import keccak256 from 'keccak256';
import { encodePacked } from 'viem';

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL || 'https://dummy-for-build.supabase.co';
const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || 'dummy_key';

export async function GET(
  req: NextRequest,
  { params }: { params: { id: string } }
) {
  try {
    const marketId = params.id;
    const { searchParams } = new URL(req.url);
    const userId = searchParams.get('userId');

    if (!marketId || !userId) {
      return NextResponse.json({ error: 'Missing marketId or userId' }, { status: 400 });
    }

    const supabase = createClient(supabaseUrl, supabaseServiceKey);

    // 1. Fetch user to get their wallet address
    const { data: user, error: userError } = await supabase
      .from('users')
      .select('wallet_address')
      .eq('id', userId)
      .single();

    if (userError || !user) {
      return NextResponse.json({ error: 'User not found' }, { status: 404 });
    }

    // 2. Fetch all bets for this market to reconstruct the Merkle tree
    const { data: bets, error: betsError } = await supabase
      .from('user_bets')
      .select('user_id, staked_amount, users ( wallet_address )')
      .eq('market_id', marketId);

    if (betsError || !bets || bets.length === 0) {
      return NextResponse.json({ error: 'No bets found for this market' }, { status: 404 });
    }

    // Group bets by user wallet address to get total staked per user
    const userBalances: Record<string, bigint> = {};
    bets.forEach((bet) => {

      const wallet = (bet as any).users?.wallet_address || '';
      if (!wallet) return;
      const amount = BigInt(Math.floor(bet.staked_amount * 1e18)); // Convert to wei string
      userBalances[wallet] = (userBalances[wallet] || BigInt(0)) + amount;
    });

    const targetWallet = user.wallet_address.toLowerCase();

    // Create leaves for the Merkle tree: keccak256(abi.encodePacked(address, uint256))
    const leaves = Object.entries(userBalances).map(([wallet, amount]) => {
        const hash = keccak256(
            encodePacked(['address', 'uint256'], [wallet as `0x${string}`, amount])
        );
        return hash;
    });

    const tree = new MerkleTree(leaves, keccak256, { sortPairs: true });

    const targetAmount = userBalances[targetWallet] || userBalances[user.wallet_address];

    if (targetAmount === undefined) {
        return NextResponse.json({ error: 'User has no stake in this market' }, { status: 404 });
    }

    const leafToProve = keccak256(
        encodePacked(['address', 'uint256'], [user.wallet_address as `0x${string}`, targetAmount])
    );

    const proof = tree.getHexProof(leafToProve);
    const root = tree.getHexRoot();

    return NextResponse.json({
        marketId,
        walletAddress: user.wallet_address,
        userBalanceWei: targetAmount.toString(),
        merkleRoot: root,
        proof
    }, { status: 200 });

  } catch (error: unknown) {
    console.error('Error generating Merkle proof:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

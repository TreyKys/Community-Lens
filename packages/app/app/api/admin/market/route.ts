import { NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';

const supabaseAdmin = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

// POST /api/admin/market — create a market in Supabase
// This is the new off-chain market creation. No gas. No blockchain transaction.
// The smart contract only learns about the market when commitBetState is called at lock time.
export async function POST(request: Request) {
  try {
    const authHeader = request.headers.get('Authorization');
    if (authHeader !== `Bearer ${process.env.ADMIN_SECRET}`) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const body = await request.json();
    const {
      title,
      question,
      category,
      options,
      closesAt,
      parentMarketId,
      fixtureId,        // football-data.org match ID (sports only)
      isJackpotEligible, // mark for jackpot engine
    } = body;

    if (!question || !category || !options || !closesAt) {
      return NextResponse.json({ error: 'Missing required fields: question, category, options, closesAt' }, { status: 400 });
    }

    if (!Array.isArray(options) || options.length < 2) {
      return NextResponse.json({ error: 'Options must be an array with at least 2 items' }, { status: 400 });
    }

    const { data: market, error } = await supabaseAdmin
      .from('markets')
      .insert({
        title: title || question.slice(0, 80),
        question,
        category,
        options,
        closes_at: closesAt,
        status: 'open',
        parent_market_id: parentMarketId || null,
        fixture_id: fixtureId || null,
        is_jackpot_eligible: isJackpotEligible || false,
        total_pool: 0,
        created_at: new Date().toISOString(),
      })
      .select('id, title, question, category, closes_at, status')
      .single();

    if (error) {
      console.error('Failed to create market:', error);
      return NextResponse.json({ error: error.message }, { status: 500 });
    }

    console.log(`Market created: ${market.id} — ${market.question}`);
    return NextResponse.json({ success: true, market }, { status: 201 });
  } catch (error: any) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}

// PATCH /api/admin/market — update market status or metadata
export async function PATCH(request: Request) {
  try {
    const authHeader = request.headers.get('Authorization');
    if (authHeader !== `Bearer ${process.env.ADMIN_SECRET}`) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const { marketId, updates } = await request.json();
    if (!marketId || !updates) {
      return NextResponse.json({ error: 'Missing marketId or updates' }, { status: 400 });
    }

    const { error } = await supabaseAdmin
      .from('markets')
      .update(updates)
      .eq('id', marketId);

    if (error) return NextResponse.json({ error: error.message }, { status: 500 });

    return NextResponse.json({ success: true });
  } catch (error: any) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}

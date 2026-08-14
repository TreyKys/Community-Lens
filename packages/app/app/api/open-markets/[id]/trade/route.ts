import { NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { getAuthUser } from '@/lib/getAuthUser';

export const dynamic = 'force-dynamic';

const supabaseAdmin = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
);

// POST /api/open-markets/[id]/trade
// Body: { clientTradeId: uuid, outcomeIdx: number, shares: number, limitTngn: number }
//
// This route is deliberately thin. Every rule that matters — pricing off the
// locked book, the balance check, the creator ban, no naked shorts, no
// complete sets, the position cap, idempotency — lives inside
// execute_open_trade, in one transaction. Enforcing any of it here instead
// would mean a second caller could bypass it.
//
// Two things the CLIENT must supply and this route will not invent:
//
//   clientTradeId — the idempotency key. If a response is lost in transit and
//     the client retries, the same key replays the original result instead of
//     placing a second trade at a new price. Generating it server-side would
//     defeat the entire mechanism, because a retry would arrive with a fresh
//     one and execute for real.
//
//   limitTngn — the slippage guard. Mandatory in the RPC, so a client that
//     forgets it gets an error rather than an unbounded fill.

export async function POST(request: Request, { params }: { params: { id: string } }) {
  const user = await getAuthUser(supabaseAdmin, request);
  if (!user) return NextResponse.json({ error: 'Please sign in' }, { status: 401 });

  const body = await request.json().catch(() => ({}));
  const clientTradeId = String(body?.clientTradeId || '');
  const outcomeIdx = Number(body?.outcomeIdx);
  const shares = Number(body?.shares);
  const limitTngn = Number(body?.limitTngn);

  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(clientTradeId)) {
    return NextResponse.json(
      { error: 'clientTradeId must be a uuid — it is what makes a retry safe' },
      { status: 400 });
  }
  if (!Number.isFinite(outcomeIdx) || outcomeIdx < 0) {
    return NextResponse.json({ error: 'Pick an outcome' }, { status: 400 });
  }
  if (!Number.isFinite(shares) || shares === 0) {
    return NextResponse.json({ error: 'Enter an amount' }, { status: 400 });
  }
  if (!Number.isFinite(limitTngn) || limitTngn <= 0) {
    return NextResponse.json(
      { error: 'A price limit is required so you cannot be filled at a worse price than you agreed' },
      { status: 400 });
  }

  const { data, error } = await supabaseAdmin.rpc('execute_open_trade', {
    p_client_trade_id: clientTradeId,
    p_market_id: params.id,
    p_user_id: user.id,
    p_outcome_idx: outcomeIdx,
    p_delta_shares: shares,
    p_limit_tngn: limitTngn,
  });

  if (error) {
    const msg = error.message || 'Trade failed';
    // P0001 is a deliberate refusal by a guard (insufficient balance, slippage,
    // creator ban, market closed...). Those are 400s the user can act on.
    // Anything else is our problem, and must not be dressed up as theirs.
    const isUserFacing = (error as any)?.code === 'P0001';
    if (!isUserFacing) console.error('[open-trade] unexpected failure', error, { market: params.id });
    return NextResponse.json({ error: msg }, { status: isUserFacing ? 400 : 500 });
  }

  const row = Array.isArray(data) ? data[0] : data;

  return NextResponse.json({
    // 'already_executed' means the key was replayed — the trade happened once
    // and this is the recorded result, not a second fill.
    outcome: row?.outcome,
    replayed: row?.outcome === 'already_executed',
    costTngn: Number(row?.cost_tngn ?? 0),
    feeTngn: Number(row?.fee_tngn ?? 0),
    totalTngn: Number(row?.total_tngn ?? 0),
    sharesAfter: Number(row?.shares_after ?? 0),
    priceAfter: Number(row?.price_after ?? 0),
  }, { headers: { 'Cache-Control': 'no-store' } });
}

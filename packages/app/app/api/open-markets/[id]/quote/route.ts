import { NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';

export const dynamic = 'force-dynamic';

const supabaseAdmin = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
);

// POST /api/open-markets/[id]/quote
// Body: { outcomeIdx: number, shares: number }   shares < 0 = sell
//
// ADVISORY ONLY. The executing RPC reprices under a row lock, so this is what
// the ticket displays, never what the user is charged. The gap between the two
// is exactly why every trade carries a limit.
//
// The round-trip figure is the important part. A ₦10,000 buy CANNOT be sold
// back for ₦10,000: you pay the 1.5% fee twice, and selling walks the price
// back down the curve you just pushed up. On a thin book that is 5-8%. Users
// discover this the first time they try to exit unless the ticket says so
// up front, and "why did I lose money when the price didn't move?" is a
// support ticket and a trust problem, not a UI nicety.

export async function POST(request: Request, { params }: { params: { id: string } }) {
  const body = await request.json().catch(() => ({}));
  const outcomeIdx = Number(body?.outcomeIdx);
  const shares = Number(body?.shares);

  if (!Number.isFinite(outcomeIdx) || outcomeIdx < 0) {
    return NextResponse.json({ error: 'Pick an outcome' }, { status: 400 });
  }
  if (!Number.isFinite(shares) || shares === 0) {
    return NextResponse.json({ error: 'Enter an amount' }, { status: 400 });
  }

  const { data, error } = await supabaseAdmin.rpc('quote_open_trade', {
    p_market_id: params.id,
    p_outcome_idx: outcomeIdx,
    p_delta_shares: shares,
  });

  if (error) {
    // The SQL guards return human-readable messages; pass them through rather
    // than replacing them with a generic failure the user cannot act on.
    return NextResponse.json({ error: error.message }, { status: 400 });
  }

  const row = Array.isArray(data) ? data[0] : data;
  const totalTngn = Number(row?.total_tngn ?? 0);

  // For a BUY, also price the immediate sell-back so the exit cost is visible
  // before committing.
  let roundTrip: any = null;
  if (shares > 0) {
    const { data: back } = await supabaseAdmin.rpc('quote_open_trade', {
      p_market_id: params.id,
      p_outcome_idx: outcomeIdx,
      p_delta_shares: -shares,
    });
    const backRow = Array.isArray(back) ? back[0] : back;
    if (backRow) {
      // total_tngn is negative on a sell (money entering the wallet).
      const proceeds = -Number(backRow.total_tngn ?? 0);
      roundTrip = {
        sellBackNowTngn: proceeds,
        costToExitTngn: totalTngn - proceeds,
        costToExitPct: totalTngn > 0 ? ((totalTngn - proceeds) / totalTngn) * 100 : 0,
      };
    }
  }

  return NextResponse.json({
    shares,
    outcomeIdx,
    costTngn: Number(row?.cost_tngn ?? 0),
    feeTngn: Number(row?.fee_tngn ?? 0),
    totalTngn,                                   // signed: + you pay, − you receive
    avgPrice: Number(row?.avg_price ?? 0),
    priceAfter: Number(row?.price_after ?? 0),
    roundTrip,
    advisory: 'Price moves with every trade. Your order carries a limit so you can never be filled worse than you agreed.',
  }, { headers: { 'Cache-Control': 'no-store' } });
}

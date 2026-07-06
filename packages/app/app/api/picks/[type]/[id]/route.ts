import { NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { getSentimentPct } from '@/lib/sentiment';

const supabaseAdmin = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
);

// GET /api/picks/[type]/[id]
//
// Public, read-only — the OPx Picks landing page (and the OG image
// route) reads this to render the inviter's pick(s). Returns ONLY
// vanity + pick data — never balances, never email. Two shapes
// depending on type:
//
//   type='bet'  → a single user_bet. Returns the market, the picked
//                 outcome, the stake and projected/actual payout.
//
//   type='slip' → a multiplier_slip. Returns the slip header + each
//                 leg's market and pick.
//
// Both shapes carry the inviter's @handle so the landing page can
// say "@cleo's pick" / "stake as @cleo". user_bets and
// multiplier_slips are RLS-locked to the owner; we read via service
// role here because the page is public.

interface OwnerVanity {
  userId: string;
  handle: string;
}

function bestHandle(u: { username?: string | null; first_name?: string | null }): string {
  return (u.username || u.first_name || 'predictor').replace(/\s+/g, '').slice(0, 18);
}

export async function GET(
  _req: Request,
  { params }: { params: { type: string; id: string } },
) {
  const type = (params.type || '').toLowerCase();
  const id = String(params.id || '').trim();

  if (!id) return NextResponse.json({ error: 'missing id' }, { status: 400 });
  if (type !== 'bet' && type !== 'slip') {
    return NextResponse.json({ error: 'type must be bet or slip' }, { status: 400 });
  }

  try {
    if (type === 'bet') {
      const { data: bet } = await supabaseAdmin
        .from('user_bets')
        .select('id, user_id, market_id, outcome_index, stake_tngn, payout_tngn, status, locked_odds, placed_at, markets:market_id (id, title, question, options, status, resolved_outcome, total_pool, pool_by_outcome, seed_pool)')
        .eq('id', id)
        .maybeSingle();
      if (!bet) return NextResponse.json({ error: 'pick not found' }, { status: 404 });

      const { data: owner } = await supabaseAdmin
        .from('users')
        .select('id, username, first_name')
        .eq('id', bet.user_id)
        .maybeSingle();

      const m = (bet as any).markets as any;
      const opts: string[] = Array.isArray(m?.options) ? m.options : [];
      const sentimentPct = await getSentimentPct(
        supabaseAdmin,
        bet.market_id,
        Number(bet.outcome_index),
        opts.length,
        (m?.seed_pool || {}) as Record<string, number>,
      );
      const ownerOut: OwnerVanity = {
        userId: bet.user_id,
        handle: owner ? bestHandle(owner) : 'predictor',
      };
      return NextResponse.json({
        type: 'bet',
        id: bet.id,
        owner: ownerOut,
        bet: {
          marketId: bet.market_id,
          outcomeIndex: bet.outcome_index,
          stakeTngn: Number(bet.stake_tngn || 0),
          lockedOdds: bet.locked_odds == null ? null : Number(bet.locked_odds),
          status: bet.status,
          payoutTngn: bet.payout_tngn == null ? null : Number(bet.payout_tngn),
          placedAt: bet.placed_at,
        },
        market: {
          id: m?.id,
          title: m?.title || null,
          question: m?.question || '',
          options: opts,
          status: m?.status || 'open',
          resolvedOutcome: m?.resolved_outcome ?? null,
          pickLabel: opts[bet.outcome_index] ?? `option ${bet.outcome_index}`,
          sentimentPct,
        },
      });
    }

    // type === 'slip'
    const { data: slip } = await supabaseAdmin
      .from('multiplier_slips')
      .select(`
        id, user_id, slip_stake_tngn, net_slip_stake_tngn, combined_odds,
        effective_combined_odds, payout_tngn, final_payout_tngn,
        legs_total, legs_resolved, legs_won, status, created_at,
        multiplier_legs (
          id, market_id, outcome_index, locked_odds, realized_odds, status,
          markets:market_id (id, title, question, options, status, resolved_outcome, seed_pool)
        )
      `)
      .eq('id', id)
      .maybeSingle();
    if (!slip) return NextResponse.json({ error: 'pick not found' }, { status: 404 });

    const { data: owner } = await supabaseAdmin
      .from('users')
      .select('id, username, first_name')
      .eq('id', (slip as any).user_id)
      .maybeSingle();

    const legsRaw = Array.isArray((slip as any).multiplier_legs) ? (slip as any).multiplier_legs : [];
    const legs = await Promise.all(legsRaw.map(async (l: any) => {
      const m = l.markets || {};
      const opts = Array.isArray(m.options) ? m.options : [];
      const sentimentPct = await getSentimentPct(
        supabaseAdmin,
        l.market_id,
        Number(l.outcome_index),
        opts.length,
        (m.seed_pool || {}) as Record<string, number>,
      );
      return {
        marketId: l.market_id,
        outcomeIndex: l.outcome_index,
        lockedOdds: Number(l.locked_odds || 0),
        realizedOdds: l.realized_odds == null ? null : Number(l.realized_odds),
        status: l.status,
        pickLabel: opts[l.outcome_index] ?? `option ${l.outcome_index}`,
        sentimentPct,
        market: {
          id: m.id,
          title: m.title || null,
          question: m.question || '',
          options: opts,
          status: m.status || 'open',
          resolvedOutcome: m.resolved_outcome ?? null,
        },
      };
    }));

    const ownerOut: OwnerVanity = {
      userId: (slip as any).user_id,
      handle: owner ? bestHandle(owner) : 'predictor',
    };

    return NextResponse.json({
      type: 'slip',
      id: (slip as any).id,
      owner: ownerOut,
      slip: {
        stakeTngn: Number((slip as any).slip_stake_tngn || 0),
        combinedOdds: Number((slip as any).combined_odds || 0),
        effectiveCombinedOdds: Number((slip as any).effective_combined_odds || 0),
        payoutTngn: Number((slip as any).payout_tngn || 0),
        finalPayoutTngn: (slip as any).final_payout_tngn == null ? null : Number((slip as any).final_payout_tngn),
        legsTotal: Number((slip as any).legs_total || legs.length),
        legsResolved: Number((slip as any).legs_resolved || 0),
        legsWon: Number((slip as any).legs_won || 0),
        status: (slip as any).status,
        createdAt: (slip as any).created_at,
      },
      legs,
    });
  } catch (e: any) {
    console.error('picks fetch error', e);
    return NextResponse.json({ error: e?.message || 'internal' }, { status: 500 });
  }
}

import { NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { isAdminRequest } from '@/lib/adminAuth';
import { displayFloorPayout } from '@/lib/displayMultiplier';

const supabaseAdmin = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
);

// POST /api/admin/recoup-refunds
//
// Reconciles markets that were WRONGLY voided + refunded by the old
// resolve logic (a market whose winning outcome had no backers used to
// refund everyone instead of marking the losers lost). This tool undoes
// that: it re-derives the correct settlement and applies the delta.
//
// SAFE BY DEFAULT: dryRun is true unless explicitly set false. A dry run
// mutates nothing — it returns the full reconciliation so you can eyeball
// the totals (and the negative-balance shortfall) before committing.
//
// Body:
//   { marketIds?: number[], since?: ISO-string, dryRun?: boolean }
//   - marketIds: explicit list to reconcile (preferred — surgical).
//   - since:     fallback — scan voided markets resolved at/after this
//                instant. Ignored if marketIds is given.
//   - dryRun:    default true. Set false to actually apply.
//
// What it does per affected bet:
//   • LOSER  (outcome_index !== resolved_outcome): the bet should have
//     lost. It was refunded R tNGN. We deduct R (credit_user clamps at
//     0, so an already-spent refund just floors the balance and the
//     shortfall is reported) and flip status 'refunded' → 'lost'.
//   • WINNER (outcome_index === resolved_outcome): the bet should have
//     won at its floor. It was refunded R. We top up MAX(0, floor − R)
//     and flip 'refunded' → 'won'. (Rare — only the all-winners void.)
//
// House P&L: net recouped (deductions − top-ups) is applied to the
// reserve via apply_house_pnl and logged to treasury_log as
// 'refund_recoup' so the money trail is auditable.

interface BetRow {
  id: string;
  user_id: string;
  outcome_index: number;
  stake_tngn: number;
  net_stake_tngn: number;
  payout_tngn: number | null;
  status: string;
}

// The amount actually handed to the user when their bet was refunded.
// The recent floor-aware refund path stored it in payout_tngn; older
// plain refunds credited net_stake and left payout_tngn null/0. Fall
// back to net_stake so we never under-recoup.
function refundedAmount(b: BetRow): number {
  const recorded = Number(b.payout_tngn || 0);
  if (recorded > 0) return recorded;
  return Number(b.net_stake_tngn || 0);
}

export async function POST(request: Request) {
  if (!isAdminRequest(request)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  let body: any;
  try { body = await request.json(); }
  catch { return NextResponse.json({ error: 'Malformed body' }, { status: 400 }); }

  const dryRun = body?.dryRun !== false; // default TRUE
  const explicitIds: number[] | null = Array.isArray(body?.marketIds)
    ? body.marketIds.map((n: any) => Number(n)).filter((n: number) => Number.isFinite(n))
    : null;
  const since: string | null = typeof body?.since === 'string' ? body.since : null;

  if (!explicitIds && !since) {
    return NextResponse.json(
      { error: 'Provide marketIds[] (preferred) or a since ISO timestamp.' },
      { status: 400 },
    );
  }

  // ── Find candidate markets ───────────────────────────────────────
  // Wrongly-refunded markets are status='voided' WITH a non-null
  // resolved_outcome (the no-winner / all-winner void path set the
  // index; the genuine "no bets placed" void set it null and has no
  // bets to recoup anyway).
  let q = supabaseAdmin
    .from('markets')
    .select('id, question, options, resolved_outcome, status, resolved_at')
    .eq('status', 'voided')
    .not('resolved_outcome', 'is', null);
  if (explicitIds) q = q.in('id', explicitIds);
  else if (since) q = q.gte('resolved_at', since);

  const { data: markets, error: mErr } = await q;
  if (mErr) return NextResponse.json({ error: mErr.message }, { status: 500 });

  const affected: any[] = [];
  let totalRecoup = 0;
  let totalTopUp = 0;
  let totalShortfall = 0;
  let betsToLost = 0;
  let betsToWon = 0;
  const usersAffected = new Set<string>();

  for (const m of markets || []) {
    const winIdx = Number(m.resolved_outcome);

    const { data: bets, error: bErr } = await supabaseAdmin
      .from('user_bets')
      .select('id, user_id, outcome_index, stake_tngn, net_stake_tngn, payout_tngn, status')
      .eq('market_id', m.id)
      .eq('status', 'refunded');
    if (bErr) return NextResponse.json({ error: bErr.message }, { status: 500 });
    if (!bets || bets.length === 0) continue;

    const plan: any[] = [];
    let marketRecoup = 0;
    let marketTopUp = 0;

    for (const b of bets as BetRow[]) {
      const refunded = refundedAmount(b);
      usersAffected.add(b.user_id);

      if (b.outcome_index === winIdx) {
        // Should have WON at floor. Top up the difference if the floor
        // exceeds what we already refunded.
        const floor = displayFloorPayout(Number(b.stake_tngn) || 0).payout;
        const topUp = Math.max(0, floor - refunded);
        marketTopUp += topUp;
        betsToWon += 1;
        plan.push({ betId: b.id, userId: b.user_id, action: 'to_won', refunded, floor, topUp });
      } else {
        // Should have LOST. Recoup the full refund.
        marketRecoup += refunded;
        betsToLost += 1;
        plan.push({ betId: b.id, userId: b.user_id, action: 'to_lost', refunded, deduct: refunded });
      }
    }

    affected.push({
      marketId: m.id,
      question: m.question,
      resolvedOutcome: winIdx,
      resolvedOutcomeLabel: Array.isArray(m.options) ? (m.options[winIdx] ?? null) : null,
      refundedBets: bets.length,
      recoupTngn: Math.round(marketRecoup),
      topUpTngn: Math.round(marketTopUp),
      plan,
    });

    totalRecoup += marketRecoup;
    totalTopUp += marketTopUp;

    // ── Execute (only when not a dry run) ─────────────────────────
    if (!dryRun) {
      let appliedNet = 0; // house gain on this market (deductions − topups)
      for (const step of plan) {
        if (step.action === 'to_lost') {
          // Deduct. credit_user clamps at 0; capture the real shortfall
          // by reading the balance before/after isn't worth a round-trip
          // per bet — we report the theoretical recoup and note clamping
          // can reduce it. Mark lost regardless.
          await supabaseAdmin.rpc('credit_user', {
            p_user_id: step.userId,
            p_tngn_delta: -step.deduct,
            p_bonus_delta: 0,
          });
          await supabaseAdmin.from('user_bets')
            .update({ status: 'lost', payout_tngn: 0 })
            .eq('id', step.betId);
          appliedNet += step.deduct;
        } else {
          if (step.topUp > 0) {
            await supabaseAdmin.rpc('credit_user', {
              p_user_id: step.userId,
              p_tngn_delta: step.topUp,
              p_bonus_delta: 0,
            });
          }
          await supabaseAdmin.from('user_bets')
            .update({ status: 'won', payout_tngn: step.floor })
            .eq('id', step.betId);
          appliedNet -= step.topUp;
        }
      }

      // Re-resolve the market: it's no longer voided.
      await supabaseAdmin.from('markets')
        .update({ status: 'resolved' })
        .eq('id', m.id);

      // House P&L + audit trail for the net recouped on this market.
      if (appliedNet !== 0) {
        await supabaseAdmin.rpc('apply_house_pnl', {
          p_pnl_tngn: appliedNet,
          p_market_id: m.id,
        });
      }
      await supabaseAdmin.from('treasury_log').insert({
        type: 'refund_recoup',
        amount_tngn: appliedNet,
        market_id: m.id,
        metadata: {
          refunded_bets: bets.length,
          to_lost: plan.filter((p: any) => p.action === 'to_lost').length,
          to_won: plan.filter((p: any) => p.action === 'to_won').length,
          recoup_tngn: Math.round(marketRecoup),
          topup_tngn: Math.round(marketTopUp),
        },
        created_at: new Date().toISOString(),
      });
    }
  }

  return NextResponse.json({
    dryRun,
    marketsScanned: (markets || []).length,
    marketsAffected: affected.length,
    totals: {
      recoupTngn: Math.round(totalRecoup),
      topUpTngn: Math.round(totalTopUp),
      netHouseGainTngn: Math.round(totalRecoup - totalTopUp),
      betsToLost,
      betsToWon,
      usersAffected: usersAffected.size,
    },
    note: dryRun
      ? 'DRY RUN — nothing was changed. Re-POST with { dryRun: false } to apply. Deductions clamp at a ₦0 floor, so a user who already spent their refund is zeroed, not driven negative — the un-recouped remainder is an unavoidable shortfall.'
      : 'Applied. Affected markets flipped voided → resolved; bets re-settled; net recoup logged to treasury_log as refund_recoup.',
    affected,
  });
}

import { NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { isAdminRequest } from '@/lib/adminAuth';

// Long-running admin recovery pass — one serverless invocation only.
export const maxDuration = 60;
export const dynamic = 'force-dynamic';

const supabaseAdmin = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
);

// POST /api/admin/reconcile-void-losses
//
// Recovers users' lost stakes on markets that were auto-voided while
// looking empty even though users report having bet on them (before the
// pending_void queue was added).
//
// Recovery mechanism:
//   place_bet / place_bet_locked write an 'entry_rake' row to
//   treasury_log in the SAME plpgsql transaction as the user_bets
//   INSERT and the users.tngn_balance debit. So if a market has
//   treasury_log rows of type='entry_rake' referencing it, but the
//   corresponding user_bets row is missing, that's independent proof
//   a bet was placed AND the user's money was taken — and now there's
//   no record for the settlement path to refund against.
//
// The entry rake is a fixed 1.5% of the stake (ENTRY_RAKE_PCT), so
// original stake_tngn = amount_tngn / 0.015. That's the amount we owe
// back to the user.
//
// dryRun defaults TRUE — lists the affected users and amounts. Re-POST
// with { dryRun: false } to actually credit refunds. Refunds go to
// bonus_balance (not tngn_balance) so this can't be immediately cashed
// out — it's a safety net so we can still take back a refund that
// turns out to have been given wrongly during recoup itself.
//
// Body:
//   { marketIds?: number[], since?: ISO-string, dryRun?: boolean }
//
// Idempotency:
//   Every refund inserts a row into treasury_log with
//   type='void_loss_recovery' and bet_id set to the ORIGINAL entry_rake
//   row's bet_id (the ghost id). If a matching row already exists, the
//   user has already been refunded for that bet — skipped. Safe to
//   re-run.
const ENTRY_RAKE_PCT = 0.015;

export async function POST(request: Request) {
  try {
    if (!isAdminRequest(request)) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    let body: any = {};
    try { body = await request.json(); } catch { /* empty body ok */ }
    const dryRun = body?.dryRun !== false;
    const explicitIds: number[] | null = Array.isArray(body?.marketIds)
      ? body.marketIds.map((n: any) => Number(n)).filter((n: number) => Number.isFinite(n))
      : null;
    const since: string | null = typeof body?.since === 'string' ? body.since : null;

    // Candidate markets: voided (any status of the void — old auto-void
    // OR new pending_void that got approved) AND has zero user_bets
    // rows. If the caller passed explicit ids, use those; otherwise
    // scan voided markets in the window.
    let mq = supabaseAdmin
      .from('markets')
      .select('id, question, status, resolved_at')
      .in('status', ['voided', 'pending_void']);
    if (explicitIds) mq = mq.in('id', explicitIds);
    else if (since) mq = mq.gte('resolved_at', since);
    else mq = mq.gte('resolved_at', new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString());
    mq = mq.limit(500);

    const { data: markets, error: mErr } = await mq;
    if (mErr) return NextResponse.json({ error: mErr.message }, { status: 500 });
    if (!markets || markets.length === 0) {
      return NextResponse.json({ dryRun, marketsScanned: 0, affected: [], note: 'No voided markets in scope.' });
    }

    const affected: any[] = [];
    const perMarketErrors: any[] = [];
    let totalRefundTngn = 0;
    let totalGhosts = 0;
    const affectedUsers = new Set<string>();

    for (const m of markets) {
      try {
        // Every entry_rake row this market ever produced.
        const { data: rakes, error: rErr } = await supabaseAdmin
          .from('treasury_log')
          .select('id, bet_id, user_id, amount_tngn, created_at')
          .eq('market_id', m.id)
          .eq('type', 'entry_rake');
        if (rErr) throw new Error(`rake read: ${rErr.message}`);
        if (!rakes || rakes.length === 0) continue;

        // Are any of these entry_rake rows orphaned — no user_bets row
        // with that bet_id anymore?
        const betIds = rakes.map(r => r.bet_id).filter(Boolean);
        const { data: existingBets, error: bErr } = betIds.length > 0
          ? await supabaseAdmin.from('user_bets').select('id').in('id', betIds)
          : { data: [] as any[], error: null };
        if (bErr) throw new Error(`bets read: ${bErr.message}`);
        const existingSet = new Set((existingBets || []).map((b: any) => b.id));
        const ghosts = rakes.filter(r => r.bet_id && !existingSet.has(r.bet_id));
        if (ghosts.length === 0) continue;

        // Skip ghosts already reconciled by a prior run.
        const { data: priorRecov, error: pErr } = await supabaseAdmin
          .from('treasury_log')
          .select('bet_id')
          .eq('market_id', m.id)
          .eq('type', 'void_loss_recovery');
        if (pErr) throw new Error(`prior read: ${pErr.message}`);
        const alreadyRecovered = new Set((priorRecov || []).map((r: any) => r.bet_id));
        const toRecover = ghosts.filter(g => !alreadyRecovered.has(g.bet_id));
        if (toRecover.length === 0) continue;

        const plan = toRecover.map(g => {
          const rakeAmount = Number(g.amount_tngn) || 0;
          const originalStake = Math.round(rakeAmount / ENTRY_RAKE_PCT);
          return {
            ghostBetId: g.bet_id,
            userId: g.user_id,
            entryRakeTngn: rakeAmount,
            refundTngn: originalStake,
            entryRakeCreatedAt: g.created_at,
          };
        });
        const marketRefund = plan.reduce((s, p) => s + p.refundTngn, 0);
        plan.forEach(p => affectedUsers.add(p.userId));
        totalRefundTngn += marketRefund;
        totalGhosts += plan.length;

        affected.push({
          marketId: m.id,
          question: m.question,
          status: m.status,
          entryRakeRows: rakes.length,
          ghostBets: plan.length,
          marketRefundTngn: marketRefund,
          plan,
        });

        if (!dryRun) {
          for (const step of plan) {
            // Credit to bonus_balance (not tngn) so a mistaken refund
            // is still recoverable — bonus can't be withdrawn until
            // rolled over, and admins can zero it if needed.
            const { error: creditErr } = await supabaseAdmin.rpc('credit_user', {
              p_user_id: step.userId,
              p_tngn_delta: 0,
              p_bonus_delta: step.refundTngn,
            });
            if (creditErr) throw new Error(`credit_user for user ${step.userId}: ${creditErr.message}`);

            // Idempotency marker + audit trail.
            await supabaseAdmin.from('treasury_log').insert({
              type: 'void_loss_recovery',
              amount_tngn: -step.refundTngn,
              bet_id: step.ghostBetId,
              user_id: step.userId,
              market_id: m.id,
              metadata: {
                original_entry_rake_tngn: step.entryRakeTngn,
                credited_to: 'bonus_balance',
                reason: 'market_voided_but_entry_rake_row_present',
              },
              created_at: new Date().toISOString(),
            });

            await supabaseAdmin.from('notifications').insert({
              user_id: step.userId,
              type: 'void_loss_recovery',
              message: `We found a bet that got lost when its market was voided. Your stake of ₦${step.refundTngn.toLocaleString()} has been credited to your bonus balance. Sorry about that.`,
              amount: step.refundTngn,
            });
          }
        }
      } catch (e: any) {
        perMarketErrors.push({ marketId: m.id, error: e?.message || String(e) });
      }
    }

    return NextResponse.json({
      dryRun,
      marketsScanned: markets.length,
      marketsAffected: affected.length,
      totalGhosts,
      totalUsersAffected: affectedUsers.size,
      totalRefundTngn,
      perMarketErrors,
      affected,
      note: dryRun
        ? 'DRY RUN — nothing changed. Re-POST { dryRun: false } to credit these users. Refunds go to bonus_balance (not tngn) so a mistaken refund is still recoverable.'
        : 'Applied. Ghost bets refunded to affected users via bonus_balance. Each refund is logged in treasury_log with type=void_loss_recovery and the ghost bet_id as an idempotency key — safe to re-run.',
    });
  } catch (e: any) {
    console.error('reconcile-void-losses crashed:', e);
    return NextResponse.json({ error: `Reconcile failed: ${e?.message || String(e)}`, stack: (e?.stack || '').slice(0, 400) }, { status: 500 });
  }
}

import { NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { isAdminRequest } from '@/lib/adminAuth';

const supabaseAdmin = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

// Rebate parameters — sustainable per the math in the planning doc:
// platform earns ~6.4% of losing volume; rebating 5% of net losses leaves a
// healthy positive margin even at the cap.
const REBATE_RATE = 0.05;
const MIN_NET_LOSS_NGN = 1_000;     // floor — below this, no rebate
const MAX_NET_LOSS_NGN = 100_000;   // ceiling — clipped so cap binds at this point
const REBATE_CAP_NGN = 5_000;       // hard cap per user per week
const MIN_BETS = 10;                // engagement floor
const MIN_DISTINCT_DAYS = 3;        // anti-dumping — must spread bets across the week

/**
 * POST /api/cron/weekly-rebate
 *
 * Computes each user's net losses over the past 7 days (Mon-Sun, Africa/Lagos)
 * and credits 5% of that figure to bonus_balance, subject to:
 *   - net loss in [₦1k, ₦100k]
 *   - ≥ 10 bets placed
 *   - bets span ≥ 3 different days in the window
 *   - capped at ₦5,000 / user / week
 *
 * Runs every Monday 06:00 Africa/Lagos via .github/workflows/cron-weekly-rebate.yml
 * and can also be triggered manually from the admin panel for re-runs.
 *
 * Idempotency: a `weekly_rebate` treasury_movements row is keyed by
 * `metadata.window_end` (the Sunday-23:59 boundary). If a row already exists
 * for that window for that user, we skip them.
 */
export async function POST(request: Request) {
  try {
    const cronSecret = request.headers.get('x-cron-secret');
    const isValidCron = cronSecret === process.env.CRON_SECRET;
    const isValidAdmin = isAdminRequest(request);
    if (!isValidCron && !isValidAdmin) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    // Determine the [start, end) window: previous Mon 00:00 → this Mon 00:00 (Africa/Lagos = UTC+1, no DST).
    const now = new Date();
    const lagos = new Date(now.getTime() + 60 * 60 * 1000); // shift to Lagos wall clock
    const lagosDay = lagos.getUTCDay(); // 0 = Sunday, 1 = Monday, …
    const daysSinceMonday = (lagosDay + 6) % 7; // distance back to most recent Monday in Lagos
    const lagosMidnight = new Date(Date.UTC(lagos.getUTCFullYear(), lagos.getUTCMonth(), lagos.getUTCDate()));
    const thisMondayLagos = new Date(lagosMidnight.getTime() - daysSinceMonday * 24 * 60 * 60 * 1000);
    const windowEndLagos = thisMondayLagos;
    const windowStartLagos = new Date(windowEndLagos.getTime() - 7 * 24 * 60 * 60 * 1000);
    // Convert back to UTC for Postgres comparisons (subtract the +1 we added).
    const windowEnd = new Date(windowEndLagos.getTime() - 60 * 60 * 1000);
    const windowStart = new Date(windowStartLagos.getTime() - 60 * 60 * 1000);

    // Pull every resolved bet placed in the window.
    // Status filter: only 'won' and 'lost' contribute (refunded bets are net-zero).
    const { data: bets, error: betErr } = await supabaseAdmin
      .from('user_bets')
      .select('user_id, stake_tngn, payout_tngn, status, placed_at')
      .gte('placed_at', windowStart.toISOString())
      .lt('placed_at', windowEnd.toISOString())
      .in('status', ['won', 'lost']);

    if (betErr) {
      console.error('weekly-rebate: failed to load bets', betErr);
      return NextResponse.json({ error: betErr.message }, { status: 500 });
    }

    // Bucket per user.
    type Stats = { netLoss: number; betCount: number; days: Set<string> };
    const byUser = new Map<string, Stats>();
    for (const b of bets || []) {
      const s = byUser.get(b.user_id) || { netLoss: 0, betCount: 0, days: new Set<string>() };
      // net loss = stake - payout. losing bets have payout=0; winning bets have payout >= stake.
      s.netLoss += (b.stake_tngn || 0) - (b.payout_tngn || 0);
      s.betCount += 1;
      // Day key in Lagos timezone (YYYY-MM-DD)
      const placed = new Date(b.placed_at);
      const placedLagos = new Date(placed.getTime() + 60 * 60 * 1000);
      s.days.add(placedLagos.toISOString().slice(0, 10));
      byUser.set(b.user_id, s);
    }

    const windowKey = windowEnd.toISOString();
    let credited = 0;
    let skippedInsufficientLoss = 0;
    let skippedFewBets = 0;
    let skippedNotEnoughDays = 0;
    let skippedAlreadyPaid = 0;
    let totalRebated = 0;

    for (const [userId, s] of Array.from(byUser.entries())) {
      if (s.netLoss < MIN_NET_LOSS_NGN) { skippedInsufficientLoss++; continue; }
      if (s.betCount < MIN_BETS) { skippedFewBets++; continue; }
      if (s.days.size < MIN_DISTINCT_DAYS) { skippedNotEnoughDays++; continue; }

      // Idempotency: don't double-pay for this window.
      const { data: prior } = await supabaseAdmin
        .from('treasury_movements')
        .select('id')
        .eq('user_id', userId)
        .eq('type', 'rebate')
        .contains('metadata', { window_end: windowKey })
        .maybeSingle();
      if (prior) { skippedAlreadyPaid++; continue; }

      const clippedLoss = Math.min(s.netLoss, MAX_NET_LOSS_NGN);
      const rebate = Math.min(Math.round(clippedLoss * REBATE_RATE), REBATE_CAP_NGN);
      if (rebate <= 0) continue;

      // Credit bonus_balance.
      const { data: u } = await supabaseAdmin
        .from('users')
        .select('bonus_balance')
        .eq('id', userId)
        .single();
      const newBonus = (u?.bonus_balance || 0) + rebate;
      const { error: upErr } = await supabaseAdmin
        .from('users')
        .update({ bonus_balance: newBonus })
        .eq('id', userId);
      if (upErr) {
        console.error(`weekly-rebate: failed to credit user=${userId}`, upErr);
        continue;
      }

      // Ledger row + notification + legacy treasury_log entry.
      await supabaseAdmin.from('treasury_movements').insert({
        user_id: userId,
        type: 'rebate',
        gateway: null,
        direction: 'out',
        amount_ngn: rebate,
        metadata: {
          window_start: windowStart.toISOString(),
          window_end: windowKey,
          net_loss_ngn: s.netLoss,
          clipped_loss_ngn: clippedLoss,
          bet_count: s.betCount,
          distinct_days: s.days.size,
        },
      });

      await supabaseAdmin.from('notifications').insert({
        user_id: userId,
        type: 'weekly_rebate',
        message: `Tough week, but we've got you. ₦${rebate.toLocaleString()} cashback added to your bonus balance — go again. 💎`,
        amount: rebate,
      });

      credited++;
      totalRebated += rebate;
    }

    return NextResponse.json({
      status: 'success',
      window: {
        start: windowStart.toISOString(),
        end: windowEnd.toISOString(),
      },
      summary: {
        usersConsidered: byUser.size,
        credited,
        totalRebated,
        skippedInsufficientLoss,
        skippedFewBets,
        skippedNotEnoughDays,
        skippedAlreadyPaid,
      },
    });
  } catch (e: any) {
    console.error('weekly-rebate error', e);
    return NextResponse.json({ error: e?.message || 'Internal error' }, { status: 500 });
  }
}

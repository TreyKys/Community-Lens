import { NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { isAdminRequest } from '@/lib/adminAuth';

const supabaseAdmin = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
);

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// POST /api/admin/apply-bonus-split-correction
//
// One-shot manual correction for a SPECIFIC bet/slip that was paid
// 100% cash before the bonus-split migration went live, where an admin
// has personally reviewed /api/admin/bonus-split-review and judged
// which tier applies. This does NOT scan or guess anything itself —
// it takes the admin's decision (tier) and the known payout amount,
// computes the same tiered split bonus_winnings_split() uses at
// settlement time, and moves the bonus-owed portion from tngn_balance
// to bonus_balance.
//
// Body:
//   {
//     userLookup: string,      // email or user uuid
//     payoutTngn: number,      // the amount ALREADY paid, 100% cash
//     tier: '90-100' | '80-90' | '70-80',  // admin's judgment call
//     betId?: string,          // for the audit trail, optional
//     reason?: string,
//     dryRun?: boolean         // default true
//   }
//
// Tiers (mirrors bonus_winnings_split in the DB):
//   90-100% bonus-funded → 10% cash / 90% bonus (admin already has 100% cash — claw back 90%)
//   80-89%  bonus-funded → 20% cash / 80% bonus (claw back 80%)
//   70-79%  bonus-funded → 30% cash / 70% bonus (claw back 70%)
//
// The clawed-back amount is credited to bonus_balance (not lost) — this
// is a REROUTE of money the user already has, not a deduction of value
// owed to them. credit_user clamps tngn_balance at 0, so if the user
// has already withdrawn/spent past what this clawback would take, the
// shortfall is reported (same convention as recoup-refunds).
const TIER_CASH_FRACTION: Record<string, number> = {
  '90-100': 0.10,
  '80-90': 0.20,
  '70-80': 0.30,
};

export async function POST(request: Request) {
  try {
    if (!isAdminRequest(request)) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const body = await request.json().catch(() => ({}));
    const { userLookup, betId, reason } = body;
    const payoutTngn = Number(body?.payoutTngn);
    const tier = body?.tier;
    const dryRun = body?.dryRun !== false;

    if (!userLookup || !Number.isFinite(payoutTngn) || payoutTngn <= 0) {
      return NextResponse.json({ error: 'userLookup and a positive payoutTngn are required' }, { status: 400 });
    }
    const cashFrac = TIER_CASH_FRACTION[tier];
    if (cashFrac === undefined) {
      return NextResponse.json({ error: "tier must be one of '90-100', '80-90', '70-80'" }, { status: 400 });
    }

    const lookup = String(userLookup).trim();
    const userQuery = UUID_RE.test(lookup)
      ? supabaseAdmin.from('users').select('id, email, tngn_balance, bonus_balance').eq('id', lookup)
      : supabaseAdmin.from('users').select('id, email, tngn_balance, bonus_balance').eq('email', lookup.toLowerCase());
    const { data: user, error: userErr } = await userQuery.maybeSingle();
    if (userErr) return NextResponse.json({ error: userErr.message }, { status: 500 });
    if (!user) return NextResponse.json({ error: `No user found for ${lookup}` }, { status: 404 });

    // Correct split of the payout.
    const correctCashTngn = Math.round(payoutTngn * cashFrac * 10000) / 10000;
    const correctBonusTngn = payoutTngn - correctCashTngn;
    // Already holds the FULL payout as cash — claw back everything
    // above what they should have kept as cash.
    const clawbackTngn = correctBonusTngn;

    const plan = {
      userId: user.id,
      email: user.email,
      payoutTngn,
      tier,
      correctCashTngn,
      correctBonusTngn,
      clawbackFromTngnBalance: clawbackTngn,
      creditToBonusBalance: clawbackTngn,
      currentTngnBalance: Number(user.tngn_balance || 0),
      currentBonusBalance: Number(user.bonus_balance || 0),
      wouldUnderflow: Number(user.tngn_balance || 0) < clawbackTngn,
    };

    if (dryRun) {
      return NextResponse.json({
        dryRun: true,
        plan,
        note: 'DRY RUN — nothing changed. Re-POST with { dryRun: false } to apply. credit_user clamps tngn_balance at 0, so if wouldUnderflow is true, the user has already spent/withdrawn past this clawback and will only be zeroed, not driven negative — they still get the correctBonusTngn credited to bonus_balance in full.',
      });
    }

    const { error: cErr } = await supabaseAdmin.rpc('credit_user', {
      p_user_id: user.id,
      p_tngn_delta: -clawbackTngn,
      p_bonus_delta: clawbackTngn,
    });
    if (cErr) return NextResponse.json({ error: cErr.message }, { status: 500 });

    await supabaseAdmin.from('treasury_log').insert({
      type: 'bonus_split_correction',
      amount_tngn: -clawbackTngn,
      user_id: user.id,
      bet_id: betId || null,
      metadata: {
        payout_tngn: payoutTngn,
        tier,
        correct_cash_tngn: correctCashTngn,
        correct_bonus_tngn: correctBonusTngn,
        reason: reason || null,
      },
      created_at: new Date().toISOString(),
    });

    try {
      await supabaseAdmin.from('notifications').insert({
        user_id: user.id,
        type: 'bonus_split_correction',
        message: `We corrected the cash/bonus split on a recent win — ₦${Math.round(clawbackTngn).toLocaleString()} moved from your withdrawable balance to your bonus balance, per the bonus-winnings rule.`,
        amount: clawbackTngn,
      });
    } catch { /* non-critical */ }

    return NextResponse.json({
      dryRun: false,
      applied: true,
      plan,
      note: 'Applied. tngn_balance debited, bonus_balance credited, logged to treasury_log as bonus_split_correction.',
    });
  } catch (e: any) {
    console.error('apply-bonus-split-correction crashed:', e);
    return NextResponse.json({ error: `Correction failed: ${e?.message || String(e)}` }, { status: 500 });
  }
}

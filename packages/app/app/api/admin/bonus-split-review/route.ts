import { NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { isAdminRequest } from '@/lib/adminAuth';

export const maxDuration = 60;
export const dynamic = 'force-dynamic';

const supabaseAdmin = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
);

// GET /api/admin/bonus-split-review?sinceHours=48&userId=...&email=...
//
// Read-only. Lists winning bets/slips from the window that were paid
// 100% cash (bonus_proportion=0 or unset — the pre-migration default)
// belonging to a user who has EVER received a bonus credit, alongside
// every bonus-granting event on their account. This is NOT an
// automatic reconciliation tool — there is no ledger of point-in-time
// balance snapshots, so we cannot know for certain what fraction of any
// given historical stake came from bonus_balance vs tngn_balance. What
// this CAN tell you safely:
//
//   - Which users are even POSSIBLY affected (had bonus activity before
//     the win) vs. definitely not (never had any bonus credit — for
//     those, bonus_proportion is provably 0, no review needed).
//   - Exactly when each bonus credit landed and how much, so a human
//     can judge whether it was plausibly still available (not yet
//     spent on an earlier bet) at the time of the flagged win.
//
// Nothing here changes any balance. Decide case-by-case, then apply a
// correction manually via /api/admin/credits (bonus_balance debit +
// tngn_balance credit, or vice versa) if you conclude a specific bet's
// payout should be re-split.
export async function GET(request: Request) {
  try {
    if (!isAdminRequest(request)) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const url = new URL(request.url);
    const sinceHours = Number(url.searchParams.get('sinceHours')) || 48;
    const sinceIso = new Date(Date.now() - sinceHours * 60 * 60 * 1000).toISOString();
    const userIdParam = url.searchParams.get('userId');
    const emailParam = url.searchParams.get('email');

    let scopedUserId: string | null = userIdParam;
    if (!scopedUserId && emailParam) {
      const { data: u, error: uErr } = await supabaseAdmin
        .from('users').select('id').eq('email', emailParam.toLowerCase()).maybeSingle();
      if (uErr) return NextResponse.json({ error: uErr.message }, { status: 500 });
      if (!u) return NextResponse.json({ error: `No user with email ${emailParam}` }, { status: 404 });
      scopedUserId = u.id;
    }

    // ── 1. Winning singles + slips paid 100% cash in the window ────────
    let betQ = supabaseAdmin
      .from('user_bets')
      .select('id, user_id, market_id, stake_tngn, net_stake_tngn, payout_tngn, bonus_proportion, placed_at, markets(question)')
      .eq('status', 'won')
      .gt('payout_tngn', 0)
      .or('bonus_proportion.is.null,bonus_proportion.eq.0')
      .gte('placed_at', sinceIso)
      .limit(500);
    if (scopedUserId) betQ = betQ.eq('user_id', scopedUserId);
    const { data: wonBets, error: betErr } = await betQ;
    if (betErr) return NextResponse.json({ error: betErr.message }, { status: 500 });

    let slipQ = supabaseAdmin
      .from('multiplier_slips')
      .select('id, user_id, slip_stake_tngn, net_slip_stake_tngn, final_payout_tngn, bonus_proportion, created_at')
      .eq('status', 'won')
      .gt('final_payout_tngn', 0)
      .or('bonus_proportion.is.null,bonus_proportion.eq.0')
      .gte('created_at', sinceIso)
      .limit(500);
    if (scopedUserId) slipQ = slipQ.eq('user_id', scopedUserId);
    const { data: wonSlips, error: slipErr } = await slipQ;
    if (slipErr) return NextResponse.json({ error: slipErr.message }, { status: 500 });

    const candidateUserIds = Array.from(new Set([
      ...(wonBets || []).map(b => b.user_id),
      ...(wonSlips || []).map(s => s.user_id),
    ]));

    if (candidateUserIds.length === 0) {
      return NextResponse.json({
        windowHours: sinceHours,
        usersReviewed: 0,
        flaggedUsers: [],
        note: 'No 100%-cash winning bets/slips in this window (for the given scope). Nothing to review.',
      });
    }

    // ── 2. Every KNOWN bonus-granting event, for those users only ───────
    // Sources: welcome match (launch_promo_grants), referral signup bonus
    // + bet insurance + manual admin credits (treasury_log), VIP referral
    // commission (vip_referral_earnings), and the flat +200 a referrer
    // gets for a normal (non-VIP) referral, which is only ever logged via
    // points_log (reason='referral_normal') — its created_at doubles as
    // the bonus-credit timestamp since both happen in the same statement.
    const [welcomeMatch, treasuryBonusRows, vipEarnings, referrerFlatBonus] = await Promise.all([
      supabaseAdmin.from('launch_promo_grants').select('user_id, credit_granted, granted_at').in('user_id', candidateUserIds),
      supabaseAdmin.from('treasury_log').select('user_id, type, amount_tngn, created_at')
        .in('user_id', candidateUserIds)
        .in('type', ['referral_signup_bonus', 'bet_insurance', 'manual_credit']),
      supabaseAdmin.from('vip_referral_earnings').select('vip_user_id, rake_share_amount, created_at').in('vip_user_id', candidateUserIds),
      supabaseAdmin.from('points_log').select('user_id, points, created_at').in('user_id', candidateUserIds).eq('reason', 'referral_normal'),
    ]);
    if (welcomeMatch.error) return NextResponse.json({ error: welcomeMatch.error.message }, { status: 500 });
    if (treasuryBonusRows.error) return NextResponse.json({ error: treasuryBonusRows.error.message }, { status: 500 });
    if (vipEarnings.error) return NextResponse.json({ error: vipEarnings.error.message }, { status: 500 });
    if (referrerFlatBonus.error) return NextResponse.json({ error: referrerFlatBonus.error.message }, { status: 500 });

    const bonusEventsByUser: Record<string, any[]> = {};
    const push = (userId: string, event: any) => {
      if (!bonusEventsByUser[userId]) bonusEventsByUser[userId] = [];
      bonusEventsByUser[userId].push(event);
    };
    for (const w of welcomeMatch.data || []) {
      push(w.user_id, { source: 'welcome_match', amountTngn: Number(w.credit_granted), at: w.granted_at });
    }
    for (const t of treasuryBonusRows.data || []) {
      push(t.user_id, { source: t.type, amountTngn: Number(t.amount_tngn), at: t.created_at });
    }
    for (const v of vipEarnings.data || []) {
      push(v.vip_user_id, { source: 'vip_referral_commission', amountTngn: Number(v.rake_share_amount), at: v.created_at });
    }
    for (const r of referrerFlatBonus.data || []) {
      push(r.user_id, { source: 'referral_normal_referrer_bonus', amountTngn: 200, at: r.created_at });
    }

    // ── 3. Only users with at least one bonus event are "possibly
    //      affected" — everyone else's flagged wins are provably
    //      100% cash-funded already, no review needed. ──────────────────
    const possiblyAffectedUserIds = candidateUserIds.filter(id => (bonusEventsByUser[id] || []).length > 0);
    const definitelyCleanUserIds = candidateUserIds.filter(id => !(bonusEventsByUser[id] || []).length);

    if (possiblyAffectedUserIds.length === 0) {
      return NextResponse.json({
        windowHours: sinceHours,
        usersReviewed: candidateUserIds.length,
        flaggedUsers: [],
        note: `${candidateUserIds.length} user(s) had a 100%-cash win in this window, but none of them have ever received a bonus credit — every one of these wins is provably correct as-is (bonus_proportion=0 is not a guess for them, it's certain).`,
      });
    }

    const { data: userRows } = await supabaseAdmin
      .from('users').select('id, email, username, bonus_balance, bonus_expires_at').in('id', possiblyAffectedUserIds);
    const userById = Object.fromEntries((userRows || []).map(u => [u.id, u]));

    const flaggedUsers = possiblyAffectedUserIds.map(uid => {
      const bets = (wonBets || []).filter(b => b.user_id === uid).map(b => ({
        kind: 'single',
        betId: b.id,
        marketId: b.market_id,
        question: (b as any).markets?.question,
        stakeTngn: Number(b.stake_tngn),
        payoutTngn: Number(b.payout_tngn),
        placedAt: b.placed_at,
      }));
      const slips = (wonSlips || []).filter(s => s.user_id === uid).map(s => ({
        kind: 'slip',
        slipId: s.id,
        stakeTngn: Number(s.slip_stake_tngn),
        payoutTngn: Number(s.final_payout_tngn),
        placedAt: (s as any).created_at,
      }));
      const events = (bonusEventsByUser[uid] || []).sort((a, b) => new Date(a.at).getTime() - new Date(b.at).getTime());
      return {
        userId: uid,
        email: userById[uid]?.email,
        username: userById[uid]?.username,
        currentBonusBalance: Number(userById[uid]?.bonus_balance || 0),
        bonusExpiresAt: userById[uid]?.bonus_expires_at,
        bonusEvents: events,
        cashWins: [...bets, ...slips].sort((a, b) => new Date(a.placedAt).getTime() - new Date(b.placedAt).getTime()),
      };
    });

    return NextResponse.json({
      windowHours: sinceHours,
      usersReviewed: candidateUserIds.length,
      definitelyCleanUserCount: definitelyCleanUserIds.length,
      flaggedUsers,
      note: 'For each flagged user: bonusEvents lists every bonus credit they have ever received (source, amount, timestamp). cashWins lists every win in this window that was paid 100% cash. Compare timestamps — a bonus event AFTER a win is irrelevant to it; a bonus event before a win (and not obviously already spent on an earlier bet) is the case to judge manually. This tool makes no changes — there is no reliable way to compute the exact historical split without a balance ledger that does not exist.',
    });
  } catch (e: any) {
    console.error('bonus-split-review crashed:', e);
    return NextResponse.json({ error: `Review failed: ${e?.message || String(e)}`, stack: (e?.stack || '').slice(0, 400) }, { status: 500 });
  }
}

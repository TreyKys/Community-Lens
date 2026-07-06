import { NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { isAdminRequest } from '@/lib/adminAuth';

const supabaseAdmin = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

// GET /api/admin/vip-leaderboard
//
// Per-VIP performance roll-up. Returns one row per VIP user (a VIP can
// own multiple codes — we group by owner_user_id) with: signups
// attributed, total rake earned, total real-money deposits driven by
// their referees, and current bonus liability outstanding.
//
// Sorts by signup count desc, deposits driven desc as tiebreaker —
// drives the right behaviour: VIPs who actually bring users in float
// up the panel; the ones who just got a code and disappeared sink.
export async function GET(request: Request) {
  if (!isAdminRequest(request)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const { data: codes } = await supabaseAdmin
      .from('referral_codes')
      .select('code, owner_user_id, uses_count, rake_share_pct, signup_bonus_tngn, is_active, created_at')
      .eq('is_vip_code', true)
      .order('uses_count', { ascending: false });

    if (!codes || codes.length === 0) {
      return NextResponse.json({ generatedAt: new Date().toISOString(), vips: [] });
    }

    const vipIds = Array.from(new Set(codes.map(c => c.owner_user_id)));

    const [vipUsers, referees, earnings] = await Promise.all([
      supabaseAdmin
        .from('users')
        .select('id, email')
        .in('id', vipIds),
      supabaseAdmin
        .from('users')
        .select('id, referred_by_user_id')
        .in('referred_by_user_id', vipIds),
      supabaseAdmin
        .from('vip_referral_earnings')
        .select('vip_user_id, rake_share_amount')
        .in('vip_user_id', vipIds),
    ]);

    const vipById = Object.fromEntries((vipUsers.data || []).map(u => [u.id, u]));

    // Map every referee to their VIP, and bucket referee_ids per VIP for
    // the deposit / bonus lookups below.
    const refereeToVip: Record<string, string> = {};
    const refereeIdsByVip: Record<string, string[]> = {};
    for (const r of (referees.data || [])) {
      const vipId = r.referred_by_user_id as string;
      refereeToVip[r.id] = vipId;
      (refereeIdsByVip[vipId] = refereeIdsByVip[vipId] || []).push(r.id);
    }
    const allRefereeIds = Object.keys(refereeToVip);

    const earningsByVip: Record<string, number> = {};
    for (const e of (earnings.data || [])) {
      const vipId = e.vip_user_id as string;
      earningsByVip[vipId] = (earningsByVip[vipId] || 0) + Number(e.rake_share_amount || 0);
    }

    let depositsByVip: Record<string, number> = {};
    let bonusByVip: Record<string, number> = {};
    if (allRefereeIds.length > 0) {
      const [depRows, bonusRows] = await Promise.all([
        supabaseAdmin
          .from('treasury_log')
          .select('user_id, amount_tngn')
          .eq('type', 'deposit')
          .in('user_id', allRefereeIds),
        supabaseAdmin
          .from('treasury_log')
          .select('amount_tngn, metadata, user_id')
          .eq('type', 'referral_signup_bonus')
          .in('user_id', allRefereeIds),
      ]);

      for (const d of (depRows.data || [])) {
        const vipId = refereeToVip[d.user_id as string];
        if (!vipId) continue;
        depositsByVip[vipId] = (depositsByVip[vipId] || 0) + Number(d.amount_tngn || 0);
      }

      // Signup bonuses are credited TO the referee; the referrer is on
      // the metadata.referrer_id so we attribute correctly even if the
      // referee later changes accounts (shouldn't happen, but cheap).
      for (const b of (bonusRows.data || [])) {
        const referrerId =
          (b.metadata as any)?.referrer_id ||
          refereeToVip[b.user_id as string] ||
          null;
        if (!referrerId) continue;
        bonusByVip[referrerId] = (bonusByVip[referrerId] || 0) + Number(b.amount_tngn || 0);
      }
    }

    // Roll up per VIP (a VIP can have multiple codes — collect them all).
    const vipsAgg: Record<string, any> = {};
    for (const c of codes) {
      const vipId = c.owner_user_id;
      if (!vipsAgg[vipId]) {
        vipsAgg[vipId] = {
          vip_user_id: vipId,
          email: vipById[vipId]?.email ?? null,
          codes: [] as any[],
          signups: refereeIdsByVip[vipId]?.length || 0,
          rake_earned: earningsByVip[vipId] || 0,
          referee_deposits: depositsByVip[vipId] || 0,
          bonus_liability: bonusByVip[vipId] || 0,
        };
      }
      vipsAgg[vipId].codes.push({
        code: c.code,
        uses_count: c.uses_count,
        rake_share_pct: Number(c.rake_share_pct) || 0,
        signup_bonus_tngn: Number(c.signup_bonus_tngn) || 0,
        is_active: c.is_active,
      });
    }

    const vips = Object.values(vipsAgg).sort((a: any, b: any) => {
      if (b.signups !== a.signups) return b.signups - a.signups;
      return b.referee_deposits - a.referee_deposits;
    });

    return NextResponse.json({ generatedAt: new Date().toISOString(), vips });
  } catch (e: any) {
    console.error('admin vip-leaderboard error', e);
    return NextResponse.json({ error: e.message || 'Internal error' }, { status: 500 });
  }
}

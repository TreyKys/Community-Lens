import { NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { isAdminRequest } from '@/lib/adminAuth';

const supabaseAdmin = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

// One-stop analytics endpoint for the admin dashboard. Aggregates the
// numbers the board cares about (treasury, users, betting activity,
// referral funnel, VIP economics) in a single call so the panel can
// render without a fan-out of 12 queries.
//
// Returns counts and sums; intentionally cheap — no per-row work.
export async function GET(request: Request) {
  if (!isAdminRequest(request)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const now = Date.now();
    const dayAgo = new Date(now - 24 * 60 * 60 * 1000).toISOString();
    const weekAgo = new Date(now - 7 * 24 * 60 * 60 * 1000).toISOString();

    // Run everything in parallel — these are independent queries.
    const [
      treasury,
      userCounts,
      vipCount,
      newUsers24h,
      newUsers7d,
      marketsByStatus,
      betsAggregate,
      bets24h,
      bets7d,
      activeBettors24h,
      referralStats,
      vipEarnings,
      insuranceCost,
      pointsOutstanding,
      withdrawalsPending,
      depositsTotal,
      promoConfig,
      promoGrants,
    ] = await Promise.all([
      supabaseAdmin.from('treasury_log').select('amount_tngn, type'),
      supabaseAdmin.from('users').select('id', { count: 'exact', head: true }),
      supabaseAdmin.from('users').select('id', { count: 'exact', head: true }).eq('is_vip', true),
      supabaseAdmin.from('users').select('id', { count: 'exact', head: true }).gte('created_at', dayAgo),
      supabaseAdmin.from('users').select('id', { count: 'exact', head: true }).gte('created_at', weekAgo),
      supabaseAdmin.from('markets').select('status'),
      supabaseAdmin.from('user_bets').select('stake_tngn, status'),
      supabaseAdmin.from('user_bets').select('stake_tngn').gte('placed_at', dayAgo),
      supabaseAdmin.from('user_bets').select('stake_tngn').gte('placed_at', weekAgo),
      supabaseAdmin.from('user_bets').select('user_id').gte('placed_at', dayAgo),
      supabaseAdmin.from('referral_codes').select('uses_count, is_vip_code'),
      supabaseAdmin.from('vip_referral_earnings').select('rake_share_amount'),
      supabaseAdmin.from('bet_insurance_events').select('refund_amount_tngn'),
      supabaseAdmin.from('users').select('points'),
      supabaseAdmin.from('withdrawals').select('amount_tngn').eq('status', 'pending_paystack'),
      supabaseAdmin.from('treasury_log').select('amount_tngn').eq('type', 'deposit'),
      supabaseAdmin.from('launch_promo').select('match_ratio, match_cap, min_deposit, cutoff, active').eq('id', 1).maybeSingle(),
      supabaseAdmin.from('launch_promo_grants').select('deposit_amount, credit_granted, granted_at'),
    ]);

    const treasuryRows = treasury.data || [];
    const sumByType = (t: string) => treasuryRows
      .filter((r: any) => r.type === t)
      .reduce((s: number, r: any) => s + Number(r.amount_tngn || 0), 0);

    const entryRake      = sumByType('entry_rake');
    const resolutionRake = sumByType('resolution_rake');
    const insurancePaid  = (insuranceCost.data || [])
      .reduce((s, r: any) => s + Number(r.refund_amount_tngn || 0), 0);

    const markets = marketsByStatus.data || [];
    const marketStatusBreakdown = {
      open:     markets.filter((m: any) => m.status === 'open').length,
      locked:   markets.filter((m: any) => m.status === 'locked').length,
      resolved: markets.filter((m: any) => m.status === 'resolved').length,
      voided:   markets.filter((m: any) => m.status === 'voided').length,
    };

    const bets = betsAggregate.data || [];
    const betAggregates = {
      totalCount: bets.length,
      totalVolume: bets.reduce((s: number, b: any) => s + Number(b.stake_tngn || 0), 0),
      activeCount: bets.filter((b: any) => b.status === 'active').length,
      wonCount:    bets.filter((b: any) => b.status === 'won').length,
      lostCount:   bets.filter((b: any) => b.status === 'lost').length,
      refundedCount: bets.filter((b: any) => b.status === 'refunded').length,
    };
    const volume24h = (bets24h.data || []).reduce((s, b: any) => s + Number(b.stake_tngn || 0), 0);
    const volume7d  = (bets7d.data  || []).reduce((s, b: any) => s + Number(b.stake_tngn || 0), 0);
    const uniqueBettors24h = new Set((activeBettors24h.data || []).map((b: any) => b.user_id)).size;

    const codes = referralStats.data || [];
    const referralBreakdown = {
      totalCodes:     codes.length,
      vipCodes:       codes.filter((c: any) => c.is_vip_code).length,
      totalReferrals: codes.reduce((s: number, c: any) => s + Number(c.uses_count || 0), 0),
      vipReferrals:   codes.filter((c: any) => c.is_vip_code).reduce((s: number, c: any) => s + Number(c.uses_count || 0), 0),
    };

    const vipEarningsTotal = (vipEarnings.data || [])
      .reduce((s, e: any) => s + Number(e.rake_share_amount || 0), 0);

    const pointsTotal = (pointsOutstanding.data || [])
      .reduce((s, u: any) => s + Number(u.points || 0), 0);

    const pendingWithdrawalAmount = (withdrawalsPending.data || [])
      .reduce((s, w: any) => s + Number(w.amount_tngn || 0), 0);

    // ── Welcome promo metrics ─────────────────────────────────────────
    // Each grant row = one user who hit a qualifying first deposit
    // inside the window. Total credit granted is our exposure; total
    // deposit triggered is the gross deposit volume the promo brought in.
    const grants = promoGrants.data || [];
    const grants24h = grants.filter((g: any) => g.granted_at >= dayAgo);
    const grants7d  = grants.filter((g: any) => g.granted_at >= weekAgo);
    const sumGrants = (rows: any[]) => rows.reduce((s, g: any) => s + Number(g.credit_granted || 0), 0);
    const sumDeposits = (rows: any[]) => rows.reduce((s, g: any) => s + Number(g.deposit_amount || 0), 0);
    const welcomePromo = {
      active:                 !!promoConfig.data?.active,
      cutoff:                 promoConfig.data?.cutoff || null,
      matchRatio:             Number(promoConfig.data?.match_ratio || 0),
      matchCap:               Number(promoConfig.data?.match_cap   || 0),
      minDeposit:             Number(promoConfig.data?.min_deposit || 0),
      totalClaims:            grants.length,
      claims24h:              grants24h.length,
      claims7d:               grants7d.length,
      creditGrantedTotal:     sumGrants(grants),
      creditGranted24h:       sumGrants(grants24h),
      depositVolumeTriggered: sumDeposits(grants),
    };
    const promoExposure = welcomePromo.creditGrantedTotal;

    const houseRevenueNet = entryRake + resolutionRake - vipEarningsTotal - insurancePaid - promoExposure;

    return NextResponse.json({
      generatedAt: new Date().toISOString(),
      treasury: {
        entryRake,
        resolutionRake,
        totalRake: entryRake + resolutionRake,
        vipPaidOut: vipEarningsTotal,
        insurancePaid,
        promoExposure,
        houseRevenueNet,
      },
      welcomePromo,
      users: {
        total: userCounts.count || 0,
        vip:   vipCount.count   || 0,
        new24h: newUsers24h.count || 0,
        new7d:  newUsers7d.count  || 0,
        activeBettors24h: uniqueBettors24h,
      },
      markets: marketStatusBreakdown,
      bets: {
        ...betAggregates,
        volume24h,
        volume7d,
      },
      referrals: referralBreakdown,
      points: {
        outstanding: pointsTotal,
      },
      withdrawals: {
        pendingCount:  (withdrawalsPending.data || []).length,
        pendingAmount: pendingWithdrawalAmount,
      },
      deposits: {
        lifetime: (depositsTotal.data || []).reduce((s, d: any) => s + Number(d.amount_tngn || 0), 0),
      },
    });
  } catch (e: any) {
    console.error('admin analytics error', e);
    return NextResponse.json({ error: e.message || 'Internal error' }, { status: 500 });
  }
}

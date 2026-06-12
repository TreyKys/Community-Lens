import { NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { isAdminRequest } from '@/lib/adminAuth';

const supabaseAdmin = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

// GET /api/admin/users/[id]
//
// Full forensic dossier for one user. Returns:
//   - Basic profile + balances + status flags (VIP, owner, custodial)
//   - Their referrer (if any) and which referees they brought in
//   - Every bet (last 50) + lifetime aggregate (counts, stake, won, win %)
//   - Every deposit (last 25 squad_transactions) + lifetime ₦ total
//   - Every withdrawal + outstanding/processed totals
//   - Every referral code they own + uses per code
//   - Points (total + breakdown by reason + last 50 entries with related user emails)
//   - Welcome match grant (if any)
//   - VIP earnings if they're a VIP
//   - Notifications (last 25)
//   - Raw treasury_log activity (last 50) — the "audit trail" view
//
// The id param accepts either a UUID or an email (admin convenience —
// you can paste either from the users-list row or from a support email).
//
// This is intentionally chatty (lots of parallel queries) so the admin
// gets a single round-trip with everything they need to investigate
// any user incident in one go.

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function GET(
  request: Request,
  { params }: { params: { id: string } },
) {
  if (!isAdminRequest(request)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const lookup = decodeURIComponent(params.id || '').trim();
    if (!lookup) return NextResponse.json({ error: 'id required' }, { status: 400 });

    const userQuery = UUID_RE.test(lookup)
      ? supabaseAdmin.from('users').select('*').eq('id', lookup)
      : supabaseAdmin.from('users').select('*').eq('email', lookup.toLowerCase());
    const { data: user } = await userQuery.maybeSingle();
    if (!user) return NextResponse.json({ error: 'User not found' }, { status: 404 });

    // Fan out — everything below depends only on the user_id we just
    // resolved, so we run them all in parallel.
    const [
      referrer,
      ownerAccountRow,
      allBets,
      recentBets,
      squadDeposits,
      withdrawals,
      ownedCodes,
      referees,
      pointsLog,
      welcomeMatch,
      vipEarnings,
      notifications,
      treasuryActivity,
    ] = await Promise.all([
      user.referred_by_user_id
        ? supabaseAdmin
            .from('users')
            .select('id, email, username')
            .eq('id', user.referred_by_user_id)
            .maybeSingle()
        : Promise.resolve({ data: null }),
      supabaseAdmin
        .from('owner_accounts')
        .select('active, notes, created_at')
        .eq('user_id', user.id)
        .maybeSingle(),
      supabaseAdmin
        .from('user_bets')
        .select('stake_tngn, payout_tngn, status, net_stake_tngn')
        .eq('user_id', user.id),
      supabaseAdmin
        .from('user_bets')
        .select('id, market_id, outcome_index, stake_tngn, net_stake_tngn, payout_tngn, status, placed_at')
        .eq('user_id', user.id)
        .order('placed_at', { ascending: false })
        .limit(50),
      supabaseAdmin
        .from('squad_transactions')
        .select('transaction_ref, amount_ngn, tngn_credited, spread_captured, status, created_at')
        .eq('user_id', user.id)
        .order('created_at', { ascending: false })
        .limit(25),
      supabaseAdmin
        .from('withdrawals')
        .select('*')
        .eq('user_id', user.id)
        .order('created_at', { ascending: false })
        .limit(25),
      supabaseAdmin
        .from('referral_codes')
        .select('code, is_vip_code, uses_count, rake_share_pct, signup_bonus_tngn, is_active, created_at')
        .eq('owner_user_id', user.id),
      supabaseAdmin
        .from('users')
        .select('id, email, username, tngn_balance, created_at')
        .eq('referred_by_user_id', user.id)
        .order('created_at', { ascending: false })
        .limit(100),
      supabaseAdmin
        .from('points_log')
        .select('reason, points, related_user_id, bet_id, metadata, created_at')
        .eq('user_id', user.id)
        .order('created_at', { ascending: false })
        .limit(50),
      supabaseAdmin
        .from('launch_promo_grants')
        .select('deposit_amount, credit_granted, granted_at')
        .eq('user_id', user.id)
        .maybeSingle(),
      supabaseAdmin
        .from('vip_referral_earnings')
        .select('market_id, referred_user_id, rake_share_amount, rake_share_pct, created_at')
        .eq('vip_user_id', user.id)
        .order('created_at', { ascending: false })
        .limit(25),
      supabaseAdmin
        .from('notifications')
        .select('type, message, amount, created_at, read_at')
        .eq('user_id', user.id)
        .order('created_at', { ascending: false })
        .limit(25),
      supabaseAdmin
        .from('treasury_log')
        .select('type, amount_tngn, metadata, created_at')
        .eq('user_id', user.id)
        .order('created_at', { ascending: false })
        .limit(50),
    ]);

    // Resolve human-readable context for recent bets (market questions +
    // outcome labels). One round-trip even if 50 bets reference 50
    // different markets.
    const marketIds = Array.from(new Set((recentBets.data || []).map(b => b.market_id)));
    let marketsById: Record<number, any> = {};
    if (marketIds.length > 0) {
      const { data: marketRows } = await supabaseAdmin
        .from('markets')
        .select('id, question, options, status')
        .in('id', marketIds);
      marketsById = Object.fromEntries((marketRows || []).map(m => [m.id, m]));
    }

    // Same for points_log.related_user_id — surfacing "you got referral
    // points from <email>" is more useful than a raw UUID.
    const relatedUserIds = Array.from(new Set(
      (pointsLog.data || []).map(p => p.related_user_id).filter(Boolean),
    ));
    let relatedUsersById: Record<string, any> = {};
    if (relatedUserIds.length > 0) {
      const { data: rows } = await supabaseAdmin
        .from('users')
        .select('id, email, username')
        .in('id', relatedUserIds as string[]);
      relatedUsersById = Object.fromEntries((rows || []).map(u => [u.id, u]));
    }

    // VIP earnings → referred user emails (same pattern)
    const refereeIdsForEarnings = Array.from(new Set(
      (vipEarnings.data || []).map(e => e.referred_user_id).filter(Boolean),
    ));
    let earningsRefereesById: Record<string, any> = {};
    if (refereeIdsForEarnings.length > 0) {
      const { data: rows } = await supabaseAdmin
        .from('users')
        .select('id, email')
        .in('id', refereeIdsForEarnings as string[]);
      earningsRefereesById = Object.fromEntries((rows || []).map(u => [u.id, u]));
    }

    // ── Aggregates ─────────────────────────────────────────────────────
    const allBetRows = allBets.data || [];
    const wonBets = allBetRows.filter(b => b.status === 'won');
    const settledBets = allBetRows.filter(b => b.status === 'won' || b.status === 'lost');
    const betSummary = {
      total: allBetRows.length,
      active: allBetRows.filter(b => b.status === 'active').length,
      won: wonBets.length,
      lost: allBetRows.filter(b => b.status === 'lost').length,
      refunded: allBetRows.filter(b => b.status === 'refunded').length,
      totalStaked: allBetRows.reduce((s, b) => s + Number(b.stake_tngn || 0), 0),
      totalWon: wonBets.reduce((s, b) => s + Number(b.payout_tngn || 0), 0),
      winRate: settledBets.length > 0 ? wonBets.length / settledBets.length : 0,
    };
    const betSummaryWithNet = {
      ...betSummary,
      // Profit = total won − total staked, excluding refunds (which net
      // to zero by definition — net_stake was returned).
      netResult: betSummary.totalWon - betSummary.totalStaked,
    };

    const depositRows = squadDeposits.data || [];
    const completedDeposits = depositRows.filter(d => d.status === 'completed');
    const depositSummary = {
      count: completedDeposits.length,
      totalNaira: completedDeposits.reduce((s, d) => s + Number(d.amount_ngn || 0), 0),
      totalCredited: completedDeposits.reduce((s, d) => s + Number(d.tngn_credited || 0), 0),
      lastDepositAt: completedDeposits[0]?.created_at ?? null,
    };

    const withdrawalRows = withdrawals.data || [];
    const withdrawalSummary = {
      count: withdrawalRows.length,
      totalProcessed: withdrawalRows
        .filter(w => w.status === 'completed' || w.status === 'approved_queued_for_paystack')
        .reduce((s, w) => s + Number(w.amount_tngn || 0), 0),
      totalPending: withdrawalRows
        .filter(w => w.status === 'pending_paystack' || w.status === 'pending_admin_approval')
        .reduce((s, w) => s + Number(w.amount_tngn || 0), 0),
    };

    const pointsRows = pointsLog.data || [];
    const pointsBreakdown: Record<string, number> = {};
    for (const p of pointsRows) {
      const reason = String(p.reason || 'other');
      pointsBreakdown[reason] = (pointsBreakdown[reason] || 0) + Number(p.points || 0);
    }

    const vipEarningsSummary = {
      count: (vipEarnings.data || []).length,
      totalEarned: (vipEarnings.data || []).reduce(
        (s, e) => s + Number(e.rake_share_amount || 0),
        0,
      ),
    };

    return NextResponse.json({
      generatedAt: new Date().toISOString(),
      user: {
        id: user.id,
        email: user.email,
        phone: user.phone,
        username: user.username,
        first_name: user.first_name,
        last_name: user.last_name,
        wallet_address: user.wallet_address,
        is_vip: user.is_vip || false,
        is_custodial: user.is_custodial,
        tngn_balance: Number(user.tngn_balance || 0),
        bonus_balance: Number(user.bonus_balance || 0),
        points: Number(user.points || 0),
        tos_accepted_at: user.tos_accepted_at,
        tos_version: user.tos_version,
        welcome_email_sent_at: user.welcome_email_sent_at,
        created_at: user.created_at,
        last_active_at: user.last_active_at,
        referred_by_user_id: user.referred_by_user_id,
        referred_by_is_vip: user.referred_by_is_vip || false,
      },
      referrer: referrer?.data ?? null,
      ownerAccount: ownerAccountRow?.data ?? null,
      bets: {
        summary: betSummaryWithNet,
        recent: (recentBets.data || []).map(b => ({
          ...b,
          market_question: marketsById[b.market_id]?.question ?? null,
          outcome_label: marketsById[b.market_id]?.options?.[b.outcome_index] ?? null,
          market_status: marketsById[b.market_id]?.status ?? null,
        })),
      },
      deposits: {
        summary: depositSummary,
        recent: depositRows,
      },
      withdrawals: {
        summary: withdrawalSummary,
        recent: withdrawalRows,
      },
      referrals: {
        codes: ownedCodes.data || [],
        referees: referees.data || [],
        refereesCount: (referees.data || []).length,
      },
      points: {
        total: Number(user.points || 0),
        breakdown: pointsBreakdown,
        recent: pointsRows.map(p => ({
          ...p,
          related_user_email: p.related_user_id
            ? (relatedUsersById[p.related_user_id]?.email ?? null)
            : null,
        })),
      },
      welcomeMatch: welcomeMatch?.data ?? null,
      vipEarnings: {
        summary: vipEarningsSummary,
        recent: (vipEarnings.data || []).map(e => ({
          ...e,
          referred_user_email: earningsRefereesById[e.referred_user_id]?.email ?? null,
        })),
      },
      notifications: notifications.data || [],
      treasuryActivity: treasuryActivity.data || [],
    });
  } catch (e: any) {
    console.error('admin user-detail error', e);
    return NextResponse.json({ error: e.message || 'Internal error' }, { status: 500 });
  }
}

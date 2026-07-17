import { NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { isAdminRequest } from '@/lib/adminAuth';

export const dynamic = 'force-dynamic';

const supabaseAdmin = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
);

// Slip-funding audit + repair for the bonus_proportion regression
// (migration 20260710010000 stamped bonus_proportion = 0 on slips placed
// while the bonus-unaware place_multiplier_slip was live).
//
// GET  — review report: candidate slips (proportion = 0 owned by a user
//        who has actually touched bonus, since a genuinely all-cash slip
//        is ALSO 0 and the two can't be told apart from stored data),
//        each with the funding CONTEXT an admin needs to ascertain the
//        source. NOTE: the exact funding split is NOT reconstructable —
//        no per-user balance snapshot is recorded at placement — so this
//        is decision-support, not a certainty.
//
// POST — apply the correction: set bonus_proportion = 1.0 (treat as
//        fully bonus-funded, the house-conservative default) on selected
//        slips. ONLY ACTIVE (unresolved) slips — an already-settled slip
//        already paid out, so changing its recorded proportion would just
//        make the record disagree with the money. Supports dryRun and
//        logs every correction to treasury_log.

const BONUS_GRANT_TYPES = ['welcome_match', 'admin_credit', 'weekly_rebate', 'bonus_grant', 'vip_referral_bonus', 'referral_signup_bonus'];

export async function GET(request: Request) {
  if (!isAdminRequest(request)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const { searchParams } = new URL(request.url);
  // Optional ISO cutoff — roughly when the regressed migration went live.
  const since = searchParams.get('since');
  // Include already-settled slips in the report (for exposure accounting).
  // Default false: only ACTIVE slips, which are the ones still fixable.
  const includeSettled = searchParams.get('includeSettled') === 'true';

  // Users who have actually touched bonus: currently hold it, or were ever
  // granted it. A user who has NEVER had bonus could not have bonus-funded a
  // slip, so their proportion = 0 is genuinely correct and excluded.
  const { data: bonusHolders } = await supabaseAdmin
    .from('users')
    .select('id')
    .gt('bonus_balance', 0);
  const { data: bonusGranted } = await supabaseAdmin
    .from('treasury_log')
    .select('user_id')
    .in('type', BONUS_GRANT_TYPES);

  const bonusUserIds = new Set<string>();
  for (const u of bonusHolders || []) if (u.id) bonusUserIds.add(u.id as string);
  for (const g of bonusGranted || []) if (g.user_id) bonusUserIds.add(g.user_id as string);

  if (bonusUserIds.size === 0) {
    return NextResponse.json({ candidates: [], summary: { total: 0, active: 0, settled: 0, note: 'No users have touched bonus — no slips at risk.' } });
  }

  const statuses = includeSettled ? ['active', 'won', 'lost', 'voided'] : ['active'];
  let q = supabaseAdmin
    .from('multiplier_slips')
    .select('id, user_id, slip_stake_tngn, net_slip_stake_tngn, payout_tngn, status, bonus_proportion, created_at')
    .in('user_id', Array.from(bonusUserIds))
    .in('status', statuses)
    .or('bonus_proportion.is.null,bonus_proportion.eq.0')
    .order('created_at', { ascending: true })
    .limit(500);
  if (since) q = q.gte('created_at', since);

  const { data: slips, error } = await q;
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  // Per-user context to help ascertain funding, resolved in bulk.
  const userIds = Array.from(new Set((slips || []).map(s => s.user_id).filter(Boolean)));
  const contextByUser: Record<string, any> = {};
  if (userIds.length > 0) {
    const { data: users } = await supabaseAdmin
      .from('users')
      .select('id, username, first_name, tngn_balance, bonus_balance')
      .in('id', userIds);
    const { data: grants } = await supabaseAdmin
      .from('treasury_log')
      .select('user_id, amount_tngn, type')
      .in('user_id', userIds)
      .in('type', BONUS_GRANT_TYPES);
    const grantedByUser: Record<string, number> = {};
    for (const g of grants || []) {
      grantedByUser[g.user_id] = (grantedByUser[g.user_id] || 0) + Number(g.amount_tngn || 0);
    }
    for (const u of users || []) {
      contextByUser[u.id] = {
        handle: u.username || u.first_name || 'user',
        currentTngn: Number(u.tngn_balance || 0),
        currentBonus: Number(u.bonus_balance || 0),
        lifetimeBonusGranted: Math.round(grantedByUser[u.id] || 0),
      };
    }
  }

  const candidates = (slips || []).map(s => {
    const ctx = contextByUser[s.user_id] || {};
    return {
      slipId: s.id,
      userId: s.user_id,
      handle: ctx.handle ?? 'user',
      status: s.status,
      slipStakeTngn: Number(s.slip_stake_tngn || 0),
      netSlipStakeTngn: Number(s.net_slip_stake_tngn || 0),
      payoutTngn: Number(s.payout_tngn || 0),
      placedAt: s.created_at,
      currentTngnBalance: ctx.currentTngn ?? null,
      currentBonusBalance: ctx.currentBonus ?? null,
      lifetimeBonusGranted: ctx.lifetimeBonusGranted ?? null,
      // Best-effort signal only — NOT a certainty. True if the user has
      // any bonus footprint at all.
      likelyBonusFunded: (ctx.currentBonus ?? 0) > 0 || (ctx.lifetimeBonusGranted ?? 0) > 0,
      fixable: s.status === 'active',
    };
  });

  const summary = {
    total: candidates.length,
    active: candidates.filter(c => c.status === 'active').length,
    settled: candidates.filter(c => c.status !== 'active').length,
    note: 'proportion=0 is ambiguous (also legit for all-cash slips). Exact split is not reconstructable — treat as review candidates. Only ACTIVE slips are fixable before resolution.',
  };

  return NextResponse.json({ candidates, summary }, { headers: { 'Cache-Control': 'no-store' } });
}

export async function POST(request: Request) {
  if (!isAdminRequest(request)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  let body: any;
  try { body = await request.json(); }
  catch { return NextResponse.json({ error: 'Malformed body' }, { status: 400 }); }

  const slipIds: string[] = Array.isArray(body?.slipIds) ? body.slipIds.map(String) : [];
  const dryRun = body?.dryRun !== false; // default to dry run — must opt out to write
  if (slipIds.length === 0) {
    return NextResponse.json({ error: 'Provide slipIds' }, { status: 400 });
  }

  // Load the targeted slips and classify. Only ACTIVE slips can be
  // corrected — a settled slip already moved money, so rewriting its
  // proportion now would only desync the record from reality.
  const { data: slips, error } = await supabaseAdmin
    .from('multiplier_slips')
    .select('id, user_id, status, bonus_proportion, slip_stake_tngn')
    .in('id', slipIds);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  const found = new Set((slips || []).map(s => s.id));
  const notFound = slipIds.filter(id => !found.has(id));
  const settledSkipped = (slips || []).filter(s => s.status !== 'active').map(s => ({ slipId: s.id, status: s.status }));
  const eligible = (slips || []).filter(s => s.status === 'active');
  const alreadyCorrect = eligible.filter(s => Number(s.bonus_proportion ?? 0) === 1);
  const toApply = eligible.filter(s => Number(s.bonus_proportion ?? 0) !== 1);

  const preview = {
    willUpdate: toApply.map(s => ({ slipId: s.id, userId: s.user_id, fromProportion: Number(s.bonus_proportion ?? 0), toProportion: 1.0 })),
    settledSkipped,
    notFound,
    alreadyFullBonus: alreadyCorrect.map(s => s.id),
  };

  if (dryRun) {
    return NextResponse.json({ dryRun: true, ...preview });
  }

  // Apply: set bonus_proportion = 1.0 on the eligible active slips, only
  // where status is STILL active (guards a concurrent resolution).
  const applied: string[] = [];
  for (const s of toApply) {
    const { data: upd, error: updErr } = await supabaseAdmin
      .from('multiplier_slips')
      .update({ bonus_proportion: 1.0 })
      .eq('id', s.id)
      .eq('status', 'active')      // re-check under write — never touch a now-settled slip
      .select('id')
      .maybeSingle();
    if (updErr || !upd) continue;
    applied.push(s.id);
    // Audit trail (amount 0 — this moves no money itself, only fixes the
    // funding record so SETTLEMENT splits correctly).
    await supabaseAdmin.from('treasury_log').insert({
      type: 'slip_bonus_proportion_correction',
      amount_tngn: 0,
      user_id: s.user_id,
      metadata: {
        slip_id: s.id,
        from_proportion: Number(s.bonus_proportion ?? 0),
        to_proportion: 1.0,
        reason: 'bonus_regression_20260710010000_repair',
      },
    }).then(() => undefined, () => undefined);
  }

  return NextResponse.json({
    dryRun: false,
    applied,
    appliedCount: applied.length,
    settledSkipped,
    notFound,
    alreadyFullBonus: alreadyCorrect.map(s => s.id),
  }, { headers: { 'Cache-Control': 'no-store' } });
}

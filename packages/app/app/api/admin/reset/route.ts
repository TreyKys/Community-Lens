import { NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { isAdminRequest } from '@/lib/adminAuth';

const supabaseAdmin = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

/**
 * POST /api/admin/reset
 *
 * Pre-launch teardown of test/sandbox data. Every action requires both
 * admin auth AND a confirm string in the body matching the action name —
 * so a single accidental click can't wipe production data. Use this BEFORE
 * launch to clear ledger/withdrawal noise from the Squad-sandbox testing
 * phase. AFTER launch, treat this endpoint as decommissioned.
 *
 * Body shapes:
 *   { action: 'reset-treasury-ledger',    confirm: 'RESET TREASURY' }
 *   { action: 'reset-treasury-ledger',    confirm: 'RESET TREASURY',  gateway: 'squad' | 'paystack' | 'manual' }
 *   { action: 'reset-withdrawals',        confirm: 'RESET WITHDRAWALS' }
 *   { action: 'reset-deposits-squad',     confirm: 'RESET DEPOSITS SQUAD' }
 *   { action: 'purge-paystack',           confirm: 'PURGE PAYSTACK' }
 *   { action: 'reset-user-balances',      confirm: 'RESET BALANCES' }
 *   { action: 'reset-bets-and-markets',   confirm: 'RESET MARKETS' }
 *   { action: 'reset-launch-data',        confirm: 'RESET LAUNCH DATA' }
 *   { action: 'reset-notifications',      confirm: 'RESET NOTIFICATIONS' }
 *   { action: 'delete-markets',           confirm: 'DELETE MARKETS', marketIds: number[] }
 *
 * Returns the number of affected rows per table so you can sanity-check.
 */

type ResetResult = { table: string; deleted: number | null };

async function deleteAll(table: string, match?: Record<string, any>): Promise<ResetResult> {
  let q = supabaseAdmin.from(table).delete({ count: 'exact' });
  // Filter mode: if no match, delete everything that exists. Supabase
  // requires at least one filter on delete, so we use a "match everything"
  // sentinel — id is not null is the simplest table-agnostic guard.
  if (match) {
    for (const [k, v] of Object.entries(match)) q = q.eq(k, v);
  } else {
    q = q.not('id', 'is', null);
  }
  const { count, error } = await q;
  if (error) throw new Error(`${table}: ${error.message}`);
  return { table, deleted: count };
}

export async function POST(request: Request) {
  if (!isAdminRequest(request)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  let body: any;
  try { body = await request.json(); } catch { body = {}; }
  const action = String(body?.action || '');
  const confirm = String(body?.confirm || '');

  try {
    if (action === 'reset-treasury-ledger' && confirm === 'RESET TREASURY') {
      const gateway = body?.gateway as string | undefined;
      const match = gateway ? { gateway } : undefined;
      const r = await deleteAll('treasury_movements', match);
      return NextResponse.json({ ok: true, scope: gateway ? `gateway=${gateway}` : 'all', results: [r] });
    }

    if (action === 'reset-withdrawals' && confirm === 'RESET WITHDRAWALS') {
      const r = await deleteAll('withdrawals');
      return NextResponse.json({ ok: true, results: [r] });
    }

    if (action === 'reset-deposits-squad' && confirm === 'RESET DEPOSITS SQUAD') {
      const r1 = await deleteAll('squad_transactions');
      const r2 = await deleteAll('treasury_movements', { gateway: 'squad' });
      return NextResponse.json({ ok: true, results: [r1, r2] });
    }

    if (action === 'purge-paystack' && confirm === 'PURGE PAYSTACK') {
      // Removes every Paystack residue: deposits ledger, treasury rows,
      // and any leftover withdrawal records tagged paystack. Paystack is
      // scrapped per board decision so this is one-way — once cleared,
      // there's nothing to reference.
      const results: ResetResult[] = [];
      results.push(await deleteAll('paystack_transactions'));
      results.push(await deleteAll('treasury_movements', { gateway: 'paystack' }));
      results.push(await deleteAll('withdrawals', { gateway: 'paystack' }));
      return NextResponse.json({ ok: true, results });
    }

    if (action === 'reset-user-balances' && confirm === 'RESET BALANCES') {
      // Zeros every user's tNGN + bonus balance. Hard reset — use only
      // before launch when wiping sandbox state.
      const { count: tngnCount, error: e1 } = await supabaseAdmin
        .from('users')
        .update({ tngn_balance: 0, bonus_balance: 0 }, { count: 'exact' })
        .not('id', 'is', null);
      if (e1) throw new Error(`users: ${e1.message}`);
      return NextResponse.json({ ok: true, results: [{ table: 'users', updated: tngnCount }] });
    }

    if (action === 'reset-bets-and-markets' && confirm === 'RESET MARKETS') {
      // Nukes all bets, all market_pool_snapshots, and resets every market
      // pool back to 0. Markets themselves stay so you don't lose your
      // catalogue, but they're back to "no one has bet yet".
      const results: ResetResult[] = [];
      results.push(await deleteAll('user_bets'));
      const { error: e1 } = await supabaseAdmin
        .from('markets')
        .update({
          total_pool: 0,
          pool_by_outcome: {},
          status: 'open',
          resolved_outcome: null,
          resolved_at: null,
        })
        .not('id', 'is', null);
      if (e1) throw new Error(`markets reset: ${e1.message}`);
      results.push({ table: 'markets', deleted: null });
      return NextResponse.json({ ok: true, results });
    }

    if (action === 'reset-launch-data' && confirm === 'RESET LAUNCH DATA') {
      // Sandbox cleanup before public launch. The goal is to make the
      // analytics dashboard reflect a true zero state without nuking the
      // market catalogue you've already curated.
      //
      // What this does:
      //   1. Delete bet-derived audit rows (bet_insurance_events,
      //      vip_referral_earnings) — they FK to user_bets.bet_id; clear
      //      them first to avoid orphans when we delete the bets.
      //   2. Delete all user_bets — wipes Vol 24h/7d/Lifetime + won/lost
      //      counters in the analytics endpoint.
      //   3. Delete every voided market — the 700+ sandbox-test rows that
      //      bloat the "Voided" tile. Resolved/locked/open markets stay.
      //   4. Zero pool_by_outcome + total_pool on the surviving markets so
      //      they don't display stale pool values now that the backing
      //      bets are gone. Status/options/question/etc. are left alone.
      //
      // What this does NOT touch:
      //   - User balances (tngn_balance, bonus_balance)
      //   - treasury_log (deposits + rake history kept as audit trail)
      //   - users / referral_codes / vip flags
      const results: ResetResult[] = [];

      results.push(await deleteAll('bet_insurance_events'));
      results.push(await deleteAll('vip_referral_earnings'));
      results.push(await deleteAll('user_bets'));

      // merkle_commits FK markets.id ON DELETE NO ACTION → clear commits
      // for the soon-to-be-deleted voided markets first. We scope to the
      // voided rows specifically so audit commits on resolved markets stay
      // intact.
      const { data: voidedMarkets, error: voidedErr } = await supabaseAdmin
        .from('markets')
        .select('id')
        .eq('status', 'voided');
      if (voidedErr) throw new Error(`markets voided lookup: ${voidedErr.message}`);
      const voidedIds = (voidedMarkets || []).map(m => m.id);
      if (voidedIds.length > 0) {
        const { count: merkleCount, error: merkleErr } = await supabaseAdmin
          .from('merkle_commits')
          .delete({ count: 'exact' })
          .in('market_id', voidedIds);
        if (merkleErr) throw new Error(`merkle_commits: ${merkleErr.message}`);
        results.push({ table: 'merkle_commits (voided)', deleted: merkleCount });
      }

      results.push(await deleteAll('markets', { status: 'voided' }));

      const { error: poolErr, count: poolCount } = await supabaseAdmin
        .from('markets')
        .update({ total_pool: 0, pool_by_outcome: {} }, { count: 'exact' })
        .not('id', 'is', null);
      if (poolErr) throw new Error(`markets pool zero: ${poolErr.message}`);
      results.push({ table: 'markets (pool zeroed)', deleted: poolCount });

      return NextResponse.json({ ok: true, results });
    }

    if (action === 'reset-notifications' && confirm === 'RESET NOTIFICATIONS') {
      const r = await deleteAll('notifications');
      return NextResponse.json({ ok: true, results: [r] });
    }

    if (action === 'delete-markets' && confirm === 'DELETE MARKETS') {
      // Targeted delete of specific markets by id. Walks the FK chain
      // (bet_insurance_events → vip_referral_earnings → user_bets →
      // merkle_commits → markets) so the markets row removal doesn't trip
      // an FK violation. Refuses if any target has sub-markets — the admin
      // must handle children explicitly (delete or re-parent them first).
      const ids = Array.isArray(body?.marketIds)
        ? body.marketIds.map((v: any) => Number(v)).filter((n: any) => Number.isFinite(n) && n > 0)
        : [];
      if (ids.length === 0) {
        return NextResponse.json(
          { error: 'marketIds must be a non-empty array of positive integers' },
          { status: 400 },
        );
      }

      // Sub-market guard. If any of the targets are a parent of another
      // market, surface the conflict instead of cascading silently.
      const { data: children, error: childErr } = await supabaseAdmin
        .from('markets')
        .select('id, question, parent_market_id')
        .in('parent_market_id', ids);
      if (childErr) throw new Error(`sub-market check: ${childErr.message}`);
      if (children && children.length > 0) {
        const blockedBy: Record<string, Array<{ id: number; question: string }>> = {};
        for (const c of children as any[]) {
          const key = String(c.parent_market_id);
          (blockedBy[key] = blockedBy[key] || []).push({ id: c.id, question: c.question });
        }
        return NextResponse.json(
          {
            error: 'One or more selected markets have sub-markets. Delete or re-parent the sub-markets first.',
            blockedBy,
          },
          { status: 409 },
        );
      }

      const results: ResetResult[] = [];

      for (const table of ['bet_insurance_events', 'vip_referral_earnings', 'user_bets', 'merkle_commits']) {
        const { count, error } = await supabaseAdmin
          .from(table)
          .delete({ count: 'exact' })
          .in('market_id', ids);
        if (error) throw new Error(`${table}: ${error.message}`);
        results.push({ table, deleted: count });
      }

      const { count: mCount, error: mErr } = await supabaseAdmin
        .from('markets')
        .delete({ count: 'exact' })
        .in('id', ids);
      if (mErr) throw new Error(`markets: ${mErr.message}`);
      results.push({ table: 'markets', deleted: mCount });

      return NextResponse.json({ ok: true, results });
    }

    return NextResponse.json(
      {
        error: 'Unknown action OR confirm string mismatch — both required and they must match exactly.',
        actions: [
          'reset-treasury-ledger      (confirm: "RESET TREASURY",   optional gateway: squad|paystack|manual)',
          'reset-withdrawals          (confirm: "RESET WITHDRAWALS")',
          'reset-deposits-squad       (confirm: "RESET DEPOSITS SQUAD")',
          'purge-paystack             (confirm: "PURGE PAYSTACK")',
          'reset-user-balances        (confirm: "RESET BALANCES")',
          'reset-bets-and-markets     (confirm: "RESET MARKETS")',
          'reset-launch-data          (confirm: "RESET LAUNCH DATA")',
          'reset-notifications        (confirm: "RESET NOTIFICATIONS")',
          'delete-markets             (confirm: "DELETE MARKETS",  marketIds: number[])',
        ],
      },
      { status: 400 }
    );
  } catch (err: any) {
    console.error('[admin/reset] failed:', err?.message || err);
    return NextResponse.json({ error: err?.message || 'Internal error' }, { status: 500 });
  }
}

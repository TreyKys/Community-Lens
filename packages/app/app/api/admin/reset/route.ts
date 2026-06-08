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
 *   { action: 'reset-notifications',      confirm: 'RESET NOTIFICATIONS' }
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

    if (action === 'reset-notifications' && confirm === 'RESET NOTIFICATIONS') {
      const r = await deleteAll('notifications');
      return NextResponse.json({ ok: true, results: [r] });
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
          'reset-notifications        (confirm: "RESET NOTIFICATIONS")',
        ],
      },
      { status: 400 }
    );
  } catch (err: any) {
    console.error('[admin/reset] failed:', err?.message || err);
    return NextResponse.json({ error: err?.message || 'Internal error' }, { status: 500 });
  }
}

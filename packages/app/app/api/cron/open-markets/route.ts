import { NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { safeSecretMatch } from '@/lib/safeCompare';

export const maxDuration = 300;
export const dynamic = 'force-dynamic';

const supabaseAdmin = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
);

// POST /api/cron/open-markets — the tick that makes this engine actually run.
//
// Every scheduled job the Open Markets engine needs, in one route. Without it
// the whole thing looks alive and quietly isn't: horizons never open, so no
// holder is ever offered the choice to leave; cash-out windows never close, so
// nobody who chose to leave is paid; settlements compute and then sit forever
// with released_at NULL. All three fail SILENTLY — there is no error anywhere,
// just money that never moves.
//
// Ordering is deliberate. Release runs before sweep so a market that finishes
// paying out has its fees swept in the same tick rather than a cron period
// later. The health scan runs last so it sees the state this tick produced.
//
// Every step is wrapped per market. release_open_settlements RAISES on a
// market that is halted, disputed, still inside its dispute window, or already
// finished — all normal conditions — so a batch that aborted on the first
// exception would let one halted market stop payouts for every other.

type StepResult = { ok: number; skipped: number; errors: string[] };
const emptyStep = (): StepResult => ({ ok: 0, skipped: 0, errors: [] });

// Keep the error list bounded: a hundred markets failing the same way should
// not produce a hundred-line response that nobody reads.
const note = (s: StepResult, marketId: string, e: unknown) => {
  if (s.errors.length < 10) {
    s.errors.push(`${marketId.slice(0, 8)}: ${e instanceof Error ? e.message : String(e)}`);
  }
};

// Tell every holder their review window is open.
//
// This is the single most important notification in the engine. The window is
// the one chance to take money out of a market that has not resolved, doing
// nothing means staying in, and a holder who never hears about it has had that
// choice made for them by silence.
async function notifyHolders(marketId: string, closesAt?: string | null) {
  const { data: mkt } = await supabaseAdmin
    .from('open_markets')
    .select('question')
    .eq('id', marketId)
    .maybeSingle();

  const { data: positions } = await supabaseAdmin
    .from('open_positions')
    .select('user_id')
    .eq('market_id', marketId)
    .eq('status', 'open')
    .gt('shares_cash', 0);

  // One notification per person, not per position: a holder with three
  // outcomes in one market has one decision to make, not three.
  const userIds = Array.from(new Set((positions || []).map((p: any) => p.user_id)));
  if (userIds.length === 0) return;

  const q = String((mkt as any)?.question || 'a market you hold');
  const when = closesAt ? ` You have until ${new Date(closesAt).toLocaleString()}.` : '';

  await supabaseAdmin.from('notifications').insert(
    userIds.map(uid => ({
      user_id: uid,
      type: 'open_market_horizon',
      message: `Review date reached on "${q.slice(0, 60)}". Stay in, or take your money out.${when}`,
      severity: 'warning',
      action_url: '/open/portfolio',
    })),
  );
}

// Tell people their money has landed. A payout that arrives silently reads as
// a payout that never arrived.
async function notifyPaid(marketId: string) {
  const { data: mkt } = await supabaseAdmin
    .from('open_markets')
    .select('question, status')
    .eq('id', marketId)
    .maybeSingle();

  const { data: rows } = await supabaseAdmin
    .from('open_settlements')
    .select('tngn, bonus, position_id, open_positions!inner(user_id)')
    .eq('market_id', marketId)
    .not('released_at', 'is', null)
    .limit(500);

  const byUser: Record<string, number> = {};
  for (const r of (rows || []) as any[]) {
    const uid = r.open_positions?.user_id;
    if (!uid) continue;
    byUser[uid] = (byUser[uid] || 0) + Number(r.tngn || 0) + Number(r.bonus || 0);
  }
  const entries = Object.entries(byUser).filter(([, amt]) => amt > 0);
  if (entries.length === 0) return;

  const q = String((mkt as any)?.question || 'a market you held');
  const voided = (mkt as any)?.status === 'voided';

  await supabaseAdmin.from('notifications').insert(
    entries.map(([uid, amt]) => ({
      user_id: uid,
      type: voided ? 'open_market_refund' : 'open_market_payout',
      message: voided
        ? `"${q.slice(0, 60)}" was voided. ₦${Math.round(amt).toLocaleString()} returned to your wallet.`
        : `"${q.slice(0, 60)}" settled. ₦${Math.round(amt).toLocaleString()} paid into your wallet.`,
      amount: amt,
      severity: 'success',
      action_url: '/open/portfolio',
    })),
  );
}

export async function POST(request: Request) {
  if (!safeSecretMatch(request.headers.get('x-cron-secret'), process.env.CRON_SECRET)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const nowIso = new Date().toISOString();
  const opened = emptyStep();
  const closed = emptyStep();
  const released = emptyStep();

  // ── 1. Open horizon windows that have come due ─────────────────────────
  // A horizon is a scheduled REVIEW date: the mechanism that stops a market
  // with no known end from trapping anyone's money indefinitely.
  const { data: dueHorizons } = await supabaseAdmin
    .from('open_markets')
    .select('id, horizon_count')
    .eq('status', 'open')
    .not('horizon_at', 'is', null)
    .lte('horizon_at', nowIso)
    .limit(50);

  for (const m of (dueHorizons || []) as any[]) {
    try {
      // horizon_count is passed as the count we READ — optimistic concurrency,
      // so two overlapping ticks cannot open the same window twice.
      const { data, error } = await supabaseAdmin.rpc('open_horizon_window', {
        p_market_id: m.id,
        p_expected_count: m.horizon_count,
        p_window_hours: 72,
      });
      if (error) throw new Error(error.message);
      const row = Array.isArray(data) ? data[0] : data;
      if (row?.applied) {
        opened.ok++;
        await notifyHolders(m.id, row?.closes_at);
      } else opened.skipped++;
    } catch (e) { note(opened, m.id, e); }
  }

  // ── 2. Close windows whose election period has expired ─────────────────
  // Leavers are paid as ONE BLOCK at a single price, so it makes no difference
  // who decided first and the holders who stay are not taxed by the exit.
  const { data: dueClose } = await supabaseAdmin
    .from('open_markets')
    .select('id, horizon_at, horizon_count')
    .eq('status', 'horizon_window')
    .not('horizon_window_closes_at', 'is', null)
    .lte('horizon_window_closes_at', nowIso)
    .limit(50);

  for (const m of (dueClose || []) as any[]) {
    try {
      // Next review date is one period further out. close_horizon_window
      // retires the market instead once it has rolled three times — a question
      // that has not resolved after four reviews is not going to.
      const base = m.horizon_at ? new Date(m.horizon_at) : new Date();
      const next = new Date(Math.max(base.getTime(), Date.now()) + 30 * 24 * 60 * 60 * 1000);
      const { data, error } = await supabaseAdmin.rpc('close_horizon_window', {
        p_market_id: m.id,
        p_next_horizon_at: next.toISOString(),
        p_dry_run: false,
      });
      if (error) throw new Error(error.message);
      const row = Array.isArray(data) ? data[0] : data;
      if (row?.applied) closed.ok++; else closed.skipped++;
    } catch (e) { note(closed, m.id, e); }
  }

  // ── 3. Release computed payouts whose dispute window has passed ────────
  // Two-phase on purpose: settlement COMPUTES under a market lock, release
  // pays out afterwards. Money already in a withdrawable balance cannot be
  // clawed back, so the dispute window is decorative unless the payout is held.
  const { data: pending } = await supabaseAdmin
    .from('open_markets')
    .select('id')
    .eq('status', 'pending_payout')
    .limit(50);

  for (const m of (pending || []) as any[]) {
    try {
      // Resumable: released_at is the cursor, so a run that dies halfway
      // continues from where it stopped rather than paying anyone twice.
      let guard = 0;
      for (;;) {
        const { data, error } = await supabaseAdmin.rpc('release_open_settlements', {
          p_market_id: m.id, p_limit: 250, p_force: false,
        });
        if (error) throw new Error(error.message);
        const row = Array.isArray(data) ? data[0] : data;
        released.ok += Number(row?.released || 0);
        if (row?.finished || Number(row?.released || 0) === 0 || ++guard > 20) {
          if (row?.finished) await notifyPaid(m.id);
          break;
        }
      }
    } catch (e) {
      // Halted, disputed, inside the window, or already finished — all normal.
      released.skipped++;
      note(released, m.id, e);
    }
  }

  // ── 4. Sweep fees into the reserve ─────────────────────────────────────
  // The trade path deliberately never touches house_reserve: doing so
  // serialised every trade on one row and deadlocked against
  // settle_multiplier_market. This reconciles the difference instead.
  let sweep = { marketsSwept: 0, tngnSwept: 0, error: null as string | null };
  try {
    const { data, error } = await supabaseAdmin.rpc('sweep_open_market_fees');
    if (error) throw new Error(error.message);
    const row = Array.isArray(data) ? data[0] : data;
    sweep = {
      marketsSwept: Number(row?.markets_swept || 0),
      tngnSwept: Number(row?.tngn_swept || 0),
      error: null,
    };
  } catch (e) {
    sweep.error = e instanceof Error ? e.message : String(e);
  }

  // ── 5. Health scan ─────────────────────────────────────────────────────
  // Runs last so it sees the state this tick produced. A critical row means a
  // book no longer matches its own trade log; it is written to notifications
  // so it surfaces without anyone having to open the dashboard.
  let critical: any[] = [];
  try {
    const { data, error } = await supabaseAdmin.rpc('scan_open_markets_health');
    if (error) throw new Error(error.message);
    critical = (data || []).filter((h: any) => h.severity === 'critical');
    if (critical.length > 0) {
      await supabaseAdmin.from('notifications').insert({
        user_id: null,
        type: 'admin_alert',
        message: `Trading health: ${critical.length} critical — `
          + critical.slice(0, 3).map((c: any) => c.check_name).join(', '),
      });
    }
  } catch {
    // A failed scan must not fail the tick — the money steps above already ran.
  }

  return NextResponse.json({
    ranAt: nowIso,
    horizonsOpened: opened,
    windowsClosed: closed,
    settlementsReleased: released,
    feeSweep: sweep,
    criticalHealthRows: critical.length,
  });
}

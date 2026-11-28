import { NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';

export const dynamic = 'force-dynamic';

const supabaseAdmin = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
);

// Player-facing surface for The Run.
//
// Quoting goes through the SAME run_coefficient the placement RPC uses, rather
// than re-deriving the price in TypeScript. A quote the player sees and a
// price they get must come from one implementation or they will eventually
// disagree — which is exactly the bug that broke Multiplier placement.

async function userFrom(request: Request) {
  const auth = request.headers.get('Authorization');
  if (!auth) return null;
  const { data: { user } } = await supabaseAdmin.auth.getUser(auth.replace('Bearer ', ''));
  return user || null;
}

function mapError(msg: string): string {
  const m = msg || '';
  if (m.includes('run_not_open') || m.includes('run_closed')) return 'Entries have closed on this Run.';
  if (m.includes('card_liability_cap')) return 'This Run is full — it has taken all the entries it can.';
  if (m.includes('user_stake_cap')) return 'You have reached the maximum stake on this Run.';
  if (m.includes('stake_above_max')) return 'That is above the maximum stake for this Run.';
  if (m.includes('stake_below_min')) return 'That is below the minimum stake.';
  if (m.includes('insufficient_balance')) return 'Not enough balance.';
  if (m.includes('need_five_picks')) return 'Pick a result for all five fixtures.';
  if (m.includes('duplicate_leg')) return 'One pick per fixture.';
  if (m.includes('bad_pick')) return 'Each pick must be Win, Draw or Loss.';
  if (m.includes('leg_already_resolved')) return 'One of these fixtures has already been played.';
  if (m.includes('in_play_locked')) return 'Cash-out is paused while a fixture is being played.';
  if (m.includes('all_legs_resolved')) return 'All fixtures are done — this Run settles shortly.';
  if (m.includes('entry_cashed_out')) return 'You have already cashed this out.';
  if (m.includes('entry_settled')) return 'This Run has already settled.';
  if (m.includes('not_your_entry')) return 'That is not your entry.';
  return 'Could not complete that.';
}

export async function GET(request: Request) {
  const { data: runs } = await supabaseAdmin
    .from('runs')
    .select('id, title, kind, status, closes_at, min_stake_tngn, max_stake_tngn, ' +
            'payout_cap_multiple, payout_cap_tngn, cashout_spread_pct')
    .in('status', ['open', 'live'])
    .order('closes_at', { ascending: true })
    .limit(20);

  const ids = (runs || []).map((r: any) => r.id);
  const legsByRun: Record<string, any[]> = {};
  if (ids.length) {
    const { data: legs } = await supabaseAdmin
      .from('run_legs')
      .select('run_id, leg_index, fixture, kickoff_at, odds_w, odds_d, odds_l, result')
      .in('run_id', ids).order('leg_index');
    for (const l of (legs || []) as any[]) (legsByRun[l.run_id] ||= []).push(l);
  }

  // The player's own live/settled entries, with a current value on each.
  let mine: any[] = [];
  const user = await userFrom(request);
  if (user) {
    const { data: entries } = await supabaseAdmin
      .from('run_entries')
      .select('id, run_id, stake_tngn, net_stake_tngn, status, payout_tngn, cashed_out_tngn, created_at')
      .eq('user_id', user.id)
      .order('created_at', { ascending: false })
      .limit(25);

    for (const e of (entries || []) as any[]) {
      const { data: picks } = await supabaseAdmin
        .from('run_entry_picks').select('leg_index, pick, odds').eq('entry_id', e.id).order('leg_index');

      let current: number | null = null;
      let cashOut: number | null = null;
      if (e.status === 'live') {
        // What the position is WORTH right now, carrying unplayed fixtures at
        // expectation. The settled-only figure counts an unplayed fixture as
        // nothing, so after one win out of five it reads far below the
        // cash-out being offered for the same position — which looks to a
        // player like losing money while being paid to leave.
        const { data: v } = await supabaseAdmin.rpc('run_entry_value',
          { p_entry_id: e.id, p_settled_only: false });
        current = Number(v || 0) * Number(e.net_stake_tngn);
        const { data: q } = await supabaseAdmin.rpc('cash_out_run_entry',
          { p_entry_id: e.id, p_user_id: user.id, p_dry_run: true });
        const row = Array.isArray(q) ? q[0] : q;
        cashOut = row?.reason === 'dry_run' ? Number(row.value_tngn) : null;
      }
      mine.push({ ...e, picks: picks || [], currentValueTngn: current, cashOutTngn: cashOut });
    }
  }

  return NextResponse.json({
    runs: (runs || []).map((r: any) => ({ ...r, legs: legsByRun[r.id] || [] })),
    myEntries: mine,
  }, { headers: { 'Cache-Control': 'no-store' } });
}

export async function POST(request: Request) {
  const body = await request.json().catch(() => ({} as any));
  const action = String(body?.action || '');

  // ── quote: price a prospective card before staking ──────────────────
  if (action === 'quote') {
    const runId = String(body?.runId || '');
    const picks = Array.isArray(body?.picks) ? body.picks : [];
    const stake = Number(body?.stake);
    if (!runId || picks.length !== 5 || !Number.isFinite(stake) || stake <= 0) {
      return NextResponse.json({ error: 'Pick all five and enter a stake' }, { status: 400 });
    }

    const { data: run } = await supabaseAdmin
      .from('runs').select('rtp_target, decay, payout_cap_multiple, payout_cap_tngn')
      .eq('id', runId).maybeSingle();
    if (!run) return NextResponse.json({ error: 'Run not found' }, { status: 404 });

    const { data: legs } = await supabaseAdmin
      .from('run_legs').select('leg_index, odds_w, odds_d, odds_l').eq('run_id', runId).order('leg_index');
    if (!legs || legs.length !== 5) return NextResponse.json({ error: 'Run not ready' }, { status: 400 });

    const odds: number[] = [], ors: number[] = [];
    for (let i = 0; i < 5; i++) {
      const p = picks.find((x: any) => Number(x.leg_index) === i);
      const leg: any = legs.find((l: any) => l.leg_index === i);
      if (!p || !leg || !['W', 'D', 'L'].includes(p.pick)) {
        return NextResponse.json({ error: 'Pick a result for all five fixtures' }, { status: 400 });
      }
      odds.push(Number(p.pick === 'W' ? leg.odds_w : p.pick === 'D' ? leg.odds_d : leg.odds_l));
      ors.push(1 / Number(leg.odds_w) + 1 / Number(leg.odds_d) + 1 / Number(leg.odds_l));
    }

    const { data: k, error } = await supabaseAdmin.rpc('run_coefficient', {
      p_odds: odds, p_overrounds: ors,
      p_rtp_target: run.rtp_target, p_decay: run.decay,
    });
    if (error) return NextResponse.json({ error: 'Could not price that' }, { status: 400 });

    const net = stake * 0.985;
    const cap = Math.min(Number(run.payout_cap_tngn), net * Number(run.payout_cap_multiple));
    const allFive = Math.min(net * Number(k) * odds.reduce((a, b) => a * b, 1), cap);

    // What four-of-five looks like — the realistic good outcome, and the
    // number that makes partial credit legible instead of theoretical.
    const worstDrop = Math.min(...odds);
    const fourOfFive = Math.min(
      net * Number(k) * (odds.reduce((a, b) => a * b, 1) / worstDrop) * Number(run.decay), cap);

    return NextResponse.json({
      coefficient: Number(k), perLegOdds: odds,
      allFiveTngn: allFive, fourOfFiveTngn: fourOfFive, capTngn: cap,
    });
  }

  // everything below needs a signed-in player
  const user = await userFrom(request);
  if (!user) return NextResponse.json({ error: 'Sign in first' }, { status: 401 });

  if (action === 'enter') {
    const { data, error } = await supabaseAdmin.rpc('place_run_entry', {
      p_user_id: user.id,
      p_run_id: String(body?.runId || ''),
      p_stake: Number(body?.stake),
      p_picks: body?.picks,
    });
    if (error) return NextResponse.json({ error: mapError(error.message) }, { status: 400 });
    const row = Array.isArray(data) ? data[0] : data;
    return NextResponse.json({
      entryId: row?.entry_id, maxPayoutTngn: Number(row?.max_payout_tngn || 0),
      newBalance: Number(row?.new_tngn || 0),
    });
  }

  if (action === 'cashout') {
    const { data, error } = await supabaseAdmin.rpc('cash_out_run_entry', {
      p_entry_id: String(body?.entryId || ''),
      p_user_id: user.id,
      p_dry_run: body?.dryRun !== false,
    });
    if (error) return NextResponse.json({ error: mapError(error.message) }, { status: 400 });
    const row = Array.isArray(data) ? data[0] : data;
    if (!row?.applied && row?.reason !== 'dry_run') {
      return NextResponse.json({ error: mapError(row?.reason || '') }, { status: 400 });
    }
    return NextResponse.json({
      preview: row?.reason === 'dry_run', valueTngn: Number(row?.value_tngn || 0),
    });
  }

  return NextResponse.json({ error: 'Unknown action' }, { status: 400 });
}

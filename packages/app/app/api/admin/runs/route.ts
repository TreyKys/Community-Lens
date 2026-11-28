import { NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { isAdminRequest } from '@/lib/adminAuth';

export const dynamic = 'force-dynamic';

const supabaseAdmin = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
);

// Admin control surface for The Run.
//
// The two presets carry the settings we arrived at by simulation, so building
// a normal card is "pick a preset, type five fixtures and their odds". Every
// number stays overridable for the cases the presets don't cover — but an
// admin should never HAVE to reason about rtp_target to publish a card.
//
// single_team is deliberately far less generous. A one-team card is not five
// independent legs: form carries several results together, and at mixed-card
// pricing that correlation measured the house edge at -24%. Prefer erratic
// teams, whose form predicts little.
// THE DECAY CURVE. decay_curve[m] is the fraction of the full-house value an
// entry keeps after m misses. This replaced the single flat 0.80 so the ladder
// could be reshaped without moving break-even: crushing 3+ misses pushes the
// coefficient up, which would lift the whole ladder, so 1 and 2 misses are
// pulled down by exactly that lift. Measured against the flat curve:
//
//   0/5, 1/5, 2/5   -40%        (losses get worse)
//   3/5             +-2%        (the break-even hinge, deliberately unmoved)
//   4/5             +-1.5%      (unmoved)
//   5/5             +48%        (the full house pays properly)
//
// Theoretical RTP is unchanged — this is a redistribution, not a margin
// change. Verified against run_coefficient_curve on live data.
const DECAY_CURVE = [0.54, 0.43, 0.205, 0.164, 0.131] as const;

const PRESETS = {
  mixed: {
    rtp_target: 0.90, decay: 0.80, cashout_spread_pct: 0.08,
    min_stake_tngn: 100, max_stake_tngn: 2000,
    // Raised from 25x alongside the curve. The curve makes the full house pay
    // ~48% more, and at 25x the cap simply confiscated the difference — which
    // is margin earned by not paying the win people were chasing, the worst
    // possible place to earn it. At 50x the measured edge lands within a point
    // of where it was before the curve. Aggregate exposure is unchanged: the
    // card liability cap, not the per-entry cap, is the real guardrail.
    payout_cap_multiple: 50, payout_cap_tngn: 50000,
    card_liability_cap_tngn: 300000,
    decay_curve: DECAY_CURVE,
  },
  single_team: {
    rtp_target: 0.65, decay: 0.80, cashout_spread_pct: 0.08,
    min_stake_tngn: 100, max_stake_tngn: 2000,
    payout_cap_multiple: 30, payout_cap_tngn: 30000,
    card_liability_cap_tngn: 150000,
    decay_curve: DECAY_CURVE,
  },
} as const;

// A curve has to strictly decrease, or an extra miss could be worth more than
// fewer misses — the database rejects that too, but an admin deserves the
// error before they hit save rather than as a failed write.
function validateCurve(c: any): { ok: true; curve: number[] | null } | { ok: false; error: string } {
  if (c === null || c === undefined) return { ok: true, curve: null };
  if (!Array.isArray(c) || c.length !== 5) {
    return { ok: false, error: 'The decay curve needs exactly 5 values (one per miss count)' };
  }
  const out: number[] = [];
  for (let i = 0; i < 5; i++) {
    const v = Number(c[i]);
    if (!Number.isFinite(v) || v <= 0 || v > 1) {
      return { ok: false, error: `Decay curve value ${i + 1} must be between 0 and 1` };
    }
    if (i > 0 && v >= out[i - 1]) {
      return {
        ok: false,
        error: `Decay curve must get smaller with each miss — value ${i + 1} (${v}) ` +
               `is not below value ${i} (${out[i - 1]}).`,
      };
    }
    out.push(v);
  }
  return { ok: true, curve: out };
}

type LegInput = {
  fixture: string; kickoff_at?: string | null;
  odds_w: number; odds_d: number; odds_l: number;
};

// A leg's overround is the margin built into its three prices. Below 1.0 the
// card is paying out more than it takes on that leg no matter what happens —
// always an error, so it is rejected rather than warned about.
function overround(l: LegInput) {
  return 1 / l.odds_w + 1 / l.odds_d + 1 / l.odds_l;
}

function validateLegs(legs: any): { ok: true; legs: LegInput[] } | { ok: false; error: string } {
  if (!Array.isArray(legs) || legs.length !== 5) {
    return { ok: false, error: 'A Run needs exactly 5 fixtures' };
  }
  const out: LegInput[] = [];
  for (let i = 0; i < 5; i++) {
    const l = legs[i] || {};
    const fixture = String(l.fixture || '').trim();
    if (fixture.length < 3) return { ok: false, error: `Fixture ${i + 1} needs a name` };
    const w = Number(l.odds_w), d = Number(l.odds_d), ls = Number(l.odds_l);
    for (const [label, v] of [['Win', w], ['Draw', d], ['Loss', ls]] as const) {
      if (!Number.isFinite(v) || v <= 1) {
        return { ok: false, error: `Fixture ${i + 1}: ${label} odds must be above 1.00` };
      }
    }
    const leg = { fixture, kickoff_at: l.kickoff_at || null, odds_w: w, odds_d: d, odds_l: ls };
    if (overround(leg) < 1.0) {
      return {
        ok: false,
        error: `Fixture ${i + 1} prices add up to ${(overround(leg) * 100).toFixed(1)}% — ` +
               `under 100% means you lose money on that fixture whatever happens. Shorten the odds.`,
      };
    }
    out.push(leg);
  }
  return { ok: true, legs: out };
}

export async function GET(request: Request) {
  if (!isAdminRequest(request)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const { data: runs, error } = await supabaseAdmin
    .from('runs')
    .select('*')
    .order('created_at', { ascending: false })
    .limit(50);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  const ids = (runs || []).map((r: any) => r.id);
  const legsByRun: Record<string, any[]> = {};
  const statsByRun: Record<string, { entries: number; staked: number; liability: number }> = {};

  if (ids.length) {
    const { data: legs } = await supabaseAdmin
      .from('run_legs').select('*').in('run_id', ids).order('leg_index');
    for (const l of (legs || []) as any[]) (legsByRun[l.run_id] ||= []).push(l);

    // Live liability per card — the number that decides whether a card can
    // still take entries. Max payout of an entry is every leg landing.
    const { data: entries } = await supabaseAdmin
      .from('run_entries')
      .select('id, run_id, status, stake_tngn, net_stake_tngn, coefficient, payout_cap_tngn')
      .in('run_id', ids);
    const { data: picks } = await supabaseAdmin
      .from('run_entry_picks')
      .select('entry_id, odds')
      .in('entry_id', (entries || []).map((e: any) => e.id));

    const oddsProd: Record<string, number> = {};
    for (const p of (picks || []) as any[]) {
      oddsProd[p.entry_id] = (oddsProd[p.entry_id] ?? 1) * Number(p.odds);
    }
    for (const e of (entries || []) as any[]) {
      const s = (statsByRun[e.run_id] ||= { entries: 0, staked: 0, liability: 0 });
      s.entries += 1;
      s.staked += Number(e.stake_tngn || 0);
      if (e.status === 'live') {
        const max = Number(e.net_stake_tngn) * Number(e.coefficient) * (oddsProd[e.id] ?? 1);
        s.liability += Math.min(max, Number(e.payout_cap_tngn));
      }
    }
  }

  return NextResponse.json({
    presets: PRESETS,
    runs: (runs || []).map((r: any) => ({
      ...r,
      legs: legsByRun[r.id] || [],
      stats: statsByRun[r.id] || { entries: 0, staked: 0, liability: 0 },
    })),
  }, { headers: { 'Cache-Control': 'no-store' } });
}

export async function POST(request: Request) {
  if (!isAdminRequest(request)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  const body = await request.json().catch(() => ({} as any));
  const action = String(body?.action || '');

  switch (action) {
    // ── ladder: what this card actually pays, before publishing it ───
    //
    // An admin types five sets of odds and a target RTP and has no way to tell
    // what a player gets for 3 right. This answers that in naira, computed
    // through the SAME coefficient RPC placement uses, so the preview cannot
    // drift from the real price. Shown for the two tickets that bracket every
    // real one: all favourites (the modal player) and all longshots.
    case 'ladder': {
      const v = validateLegs(body?.legs);
      if (!v.ok) return NextResponse.json({ error: v.error }, { status: 400 });

      const kind = body?.kind === 'single_team' ? 'single_team' : 'mixed';
      const { decay_curve: presetCurve, ...numericPreset } = PRESETS[kind];
      const cfg: Record<string, number> = { ...numericPreset };
      for (const k of Object.keys(numericPreset)) {
        const raw = body?.config?.[k];
        if (raw !== undefined && raw !== null && raw !== '') {
          const n = Number(raw);
          if (Number.isFinite(n)) cfg[k] = n;
        }
      }
      const cv = validateCurve(
        body?.config?.decay_curve === undefined ? [...presetCurve] : body.config.decay_curve);
      if (!cv.ok) return NextResponse.json({ error: cv.error }, { status: 400 });

      const stake = Number(body?.stake) > 0 ? Number(body.stake) : 500;
      const net = stake * 0.985;
      const cap = Math.min(cfg.payout_cap_tngn, net * cfg.payout_cap_multiple);

      const { data: curve, error: cErr } = await supabaseAdmin.rpc('run_decay_curve', {
        p_decay: cfg.decay, p_curve: cv.curve,
      });
      if (cErr) return NextResponse.json({ error: cErr.message }, { status: 400 });
      const D = [1, ...(curve as number[]).map(Number)];

      const shapes: Record<string, number[]> = {
        favourites: v.legs.map(l => Math.min(l.odds_w, l.odds_d, l.odds_l)),
        longshots: v.legs.map(l => Math.max(l.odds_w, l.odds_d, l.odds_l)),
      };
      const ors = v.legs.map(overround);

      const out: Record<string, any> = {};
      for (const [name, odds] of Object.entries(shapes)) {
        const { data: k, error } = await supabaseAdmin.rpc('run_coefficient_curve', {
          p_odds: odds, p_overrounds: ors, p_rtp_target: cfg.rtp_target, p_curve: curve,
        });
        if (error) return NextResponse.json({ error: error.message }, { status: 400 });

        // Every hit pattern, bucketed by how many landed. 32 of them.
        const rows: { hits: number; low: number; high: number; capped: boolean }[] = [];
        for (let h = 0; h <= 5; h++) rows.push({ hits: h, low: Infinity, high: 0, capped: false });
        for (let mask = 0; mask < 32; mask++) {
          let hits = 0, prod = 1;
          for (let i = 0; i < 5; i++) {
            if ((mask >> i) & 1) { hits++; prod *= odds[i]; }
          }
          const raw = net * Number(k) * prod * D[5 - hits];
          const paid = Math.min(raw, cap);
          const r = rows[hits];
          r.low = Math.min(r.low, paid); r.high = Math.max(r.high, paid);
          if (raw > cap) r.capped = true;
        }
        out[name] = {
          coefficient: Number(k),
          rows: rows.map(r => ({ ...r, low: r.low === Infinity ? 0 : r.low })),
        };
      }

      return NextResponse.json({
        stake, netStake: net, capTngn: cap, decayCurve: D.slice(1), ladder: out,
      });
    }

    // ── create / edit a draft ────────────────────────────────────────
    case 'save': {
      const kind = body?.kind === 'single_team' ? 'single_team' : 'mixed';
      const title = String(body?.title || '').trim();
      if (title.length < 3) {
        return NextResponse.json({ error: 'Give the card a title' }, { status: 400 });
      }
      if (!body?.closes_at) {
        return NextResponse.json({ error: 'Set when entries close' }, { status: 400 });
      }
      const v = validateLegs(body?.legs);
      if (!v.ok) return NextResponse.json({ error: v.error }, { status: 400 });

      // Preset first, explicit overrides second. decay_curve is handled apart
      // from the rest because it is an array, and Number() on an array is NaN.
      const { decay_curve: presetCurve, ...numericPreset } = PRESETS[kind];
      const cfg: Record<string, number> = { ...numericPreset };
      for (const k of Object.keys(numericPreset)) {
        if (body?.config && body.config[k] !== undefined && body.config[k] !== null && body.config[k] !== '') {
          const n = Number(body.config[k]);
          if (Number.isFinite(n)) cfg[k] = n;
        }
      }

      const cv = validateCurve(
        body?.config?.decay_curve === undefined ? [...presetCurve] : body.config.decay_curve);
      if (!cv.ok) return NextResponse.json({ error: cv.error }, { status: 400 });

      const runRow = { title, kind, closes_at: body.closes_at, ...cfg, decay_curve: cv.curve };
      let runId: string = String(body?.id || '');

      if (runId) {
        const { data: existing } = await supabaseAdmin
          .from('runs').select('status').eq('id', runId).maybeSingle();
        if (!existing) return NextResponse.json({ error: 'Run not found' }, { status: 404 });
        // Once a card is published the odds are a contract with whoever has
        // already staked. Editing is draft-only, deliberately.
        if (existing.status !== 'draft') {
          return NextResponse.json({
            error: `This card is "${existing.status}" — only drafts can be edited. Players have already been priced against these odds.`,
          }, { status: 400 });
        }
        const { error } = await supabaseAdmin.from('runs').update(runRow).eq('id', runId);
        if (error) return NextResponse.json({ error: error.message }, { status: 500 });
        await supabaseAdmin.from('run_legs').delete().eq('run_id', runId);
      } else {
        const { data, error } = await supabaseAdmin
          .from('runs').insert({ ...runRow, status: 'draft' }).select('id').single();
        if (error) return NextResponse.json({ error: error.message }, { status: 500 });
        runId = data.id;
      }

      const { error: legErr } = await supabaseAdmin.from('run_legs').insert(
        v.legs.map((l, i) => ({ run_id: runId, leg_index: i, ...l })),
      );
      if (legErr) return NextResponse.json({ error: legErr.message }, { status: 500 });

      return NextResponse.json({ id: runId, saved: true });
    }

    case 'publish': {
      const { data, error } = await supabaseAdmin
        .from('runs').update({ status: 'open' })
        .eq('id', String(body?.id || '')).eq('status', 'draft').select('id').maybeSingle();
      if (error) return NextResponse.json({ error: error.message }, { status: 500 });
      if (!data) return NextResponse.json({ error: 'Only a draft can be published' }, { status: 400 });
      return NextResponse.json({ published: true });
    }

    case 'unpublish': {
      // Safe only while nobody has staked.
      const { count } = await supabaseAdmin
        .from('run_entries').select('id', { count: 'exact', head: true })
        .eq('run_id', String(body?.id || ''));
      if ((count || 0) > 0) {
        return NextResponse.json({ error: `${count} entries already placed — void it instead` }, { status: 400 });
      }
      const { error } = await supabaseAdmin
        .from('runs').update({ status: 'draft' }).eq('id', String(body?.id || '')).eq('status', 'open');
      if (error) return NextResponse.json({ error: error.message }, { status: 500 });
      return NextResponse.json({ unpublished: true });
    }

    case 'resolve_leg': {
      const { data, error } = await supabaseAdmin.rpc('resolve_run_leg', {
        p_run_id: String(body?.id || ''),
        p_leg_index: Number(body?.legIndex),
        p_result: String(body?.result || ''),
      });
      if (error) return NextResponse.json({ error: error.message }, { status: 400 });
      const row = Array.isArray(data) ? data[0] : data;
      if (!row?.applied) return NextResponse.json({ error: row?.reason || 'Could not resolve' }, { status: 400 });
      return NextResponse.json({
        resolved: true, legsResolved: row.legs_resolved, allResolved: row.all_resolved,
      });
    }

    case 'settle': {
      const { data, error } = await supabaseAdmin.rpc('settle_run', {
        p_run_id: String(body?.id || ''), p_dry_run: body?.dryRun !== false,
      });
      if (error) return NextResponse.json({ error: error.message }, { status: 400 });
      const row = Array.isArray(data) ? data[0] : data;
      if (!row?.applied && row?.reason !== 'dry_run') {
        return NextResponse.json({ error: row?.reason || 'Could not settle' }, { status: 400 });
      }
      return NextResponse.json({
        preview: row?.reason === 'dry_run',
        entries: Number(row?.entries || 0),
        winners: Number(row?.winners || 0),
        paidTngn: Number(row?.paid_tngn || 0),
      });
    }

    case 'void': {
      const { data, error } = await supabaseAdmin.rpc('void_run', {
        p_run_id: String(body?.id || ''), p_dry_run: body?.dryRun !== false,
      });
      if (error) return NextResponse.json({ error: error.message }, { status: 400 });
      const row = Array.isArray(data) ? data[0] : data;
      if (!row?.applied && row?.reason !== 'dry_run') {
        return NextResponse.json({ error: row?.reason || 'Could not void' }, { status: 400 });
      }
      return NextResponse.json({
        preview: row?.reason === 'dry_run',
        refunded: Number(row?.refunded || 0),
        refundedTngn: Number(row?.refunded_tngn || 0),
      });
    }

    case 'delete_draft': {
      const id = String(body?.id || '');
      const { data: r } = await supabaseAdmin.from('runs').select('status').eq('id', id).maybeSingle();
      if (!r) return NextResponse.json({ error: 'Run not found' }, { status: 404 });
      if (r.status !== 'draft') {
        return NextResponse.json({ error: 'Only a draft can be deleted' }, { status: 400 });
      }
      await supabaseAdmin.from('run_legs').delete().eq('run_id', id);
      await supabaseAdmin.from('runs').delete().eq('id', id);
      return NextResponse.json({ deleted: true });
    }

    default:
      return NextResponse.json({ error: `Unknown action: ${action}` }, { status: 400 });
  }
}

import { NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { isAdminRequest } from '@/lib/adminAuth';

const supabaseAdmin = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

// GET /api/admin/markets/[id]
//
// Full admin dossier for one market. Critical difference vs. the
// public /api/markets/chart endpoint: this one is NOT scoped to bets
// with status='active'. It returns the distribution + bet ledger
// computed from EVERY bet ever placed on the market — including
// won/lost/refunded ones. Lets admin see exactly what the market
// looked like even after it's resolved or voided.
//
// Data is preserved by virtue of user_bets being permanent — once a
// bet row exists it isn't deleted, only its status changes. So the
// distribution is reconstructible from June 11 onwards for any market
// admin hasn't explicitly nuked via the targeted-delete tool.

export async function GET(
  request: Request,
  { params }: { params: { id: string } },
) {
  if (!isAdminRequest(request)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const marketId = Number(params.id);
    if (!Number.isFinite(marketId)) {
      return NextResponse.json({ error: 'id must be a number' }, { status: 400 });
    }

    const { data: market } = await supabaseAdmin
      .from('markets')
      .select('*')
      .eq('id', marketId)
      .maybeSingle();
    if (!market) return NextResponse.json({ error: 'Market not found' }, { status: 404 });

    const [bets, snapshots, merkle, parent, children] = await Promise.all([
      // Every bet that ever existed on this market, ordered chronologically.
      // We don't filter by status — that's what makes this different from
      // the public chart endpoint.
      supabaseAdmin
        .from('user_bets')
        .select('id, user_id, outcome_index, stake_tngn, net_stake_tngn, payout_tngn, status, placed_at, is_jackpot_eligible')
        .eq('market_id', marketId)
        .order('placed_at', { ascending: true }),
      // Periodic pool snapshots if the table exists (silently ignore if not).
      supabaseAdmin
        .from('market_snapshots')
        .select('total_pool, created_at')
        .eq('market_id', marketId)
        .order('created_at', { ascending: true }),
      // On-chain merkle commits (the cryptographic seal at lock time).
      supabaseAdmin
        .from('merkle_commits')
        .select('root_hash, tx_hash, committed_at')
        .eq('market_id', marketId)
        .order('committed_at', { ascending: false }),
      // Parent market reference (for sub-markets).
      market.parent_market_id
        ? supabaseAdmin
            .from('markets')
            .select('id, question')
            .eq('id', market.parent_market_id)
            .maybeSingle()
        : Promise.resolve({ data: null }),
      // Direct children (sub-markets).
      supabaseAdmin
        .from('markets')
        .select('id, question, status, total_pool')
        .eq('parent_market_id', marketId)
        .order('id', { ascending: false }),
    ]);

    const allBets = bets.data || [];
    const options = (market.options as string[]) || [];

    // Resolve bettor emails in one round-trip so admin can see who
    // placed each bet rather than scrolling through UUIDs.
    const bettorIds = Array.from(new Set(allBets.map(b => b.user_id)));
    let bettorsById: Record<string, any> = {};
    if (bettorIds.length > 0) {
      const { data: users } = await supabaseAdmin
        .from('users')
        .select('id, email, username, is_vip')
        .in('id', bettorIds);
      bettorsById = Object.fromEntries((users || []).map(u => [u.id, u]));
    }

    // ── Distribution computed from ALL bets ──────────────────────────
    // We include every status because admin wants to see the historical
    // picture, not just what's currently active.
    const optionTotals = options.map(() => 0);
    const optionCounts = options.map(() => 0);
    for (const b of allBets) {
      const i = b.outcome_index ?? -1;
      if (i >= 0 && i < options.length) {
        optionTotals[i] += Number(b.net_stake_tngn || 0);
        optionCounts[i] += 1;
      }
    }
    const totalNetPool = optionTotals.reduce((s, v) => s + v, 0);
    const distribution = options.map((opt, i) => ({
      option: opt,
      amount: optionTotals[i],
      bet_count: optionCounts[i],
      percentage: totalNetPool > 0 ? Math.round((optionTotals[i] / totalNetPool) * 100) : 0,
      is_winning: market.resolved_outcome === i,
    }));

    // ── Cumulative timeline (per-outcome running totals over time) ───
    // Bucket bets by hour and accumulate. Looks like the public chart
    // but is computed from every bet, not just active ones.
    const hourMap: Record<string, number[]> = {};
    for (const b of allBets) {
      const hour = new Date(b.placed_at).toISOString().slice(0, 13) + ':00';
      if (!hourMap[hour]) hourMap[hour] = options.map(() => 0);
      hourMap[hour][b.outcome_index] = (hourMap[hour][b.outcome_index] || 0) + Number(b.net_stake_tngn || 0);
    }
    const hours = Object.keys(hourMap).sort();
    const running = options.map(() => 0);
    const timeline: any[] = [];
    for (const hour of hours) {
      options.forEach((_, i) => { running[i] += hourMap[hour][i] || 0; });
      const entry: any = { time: hour, total: running.reduce((s, v) => s + v, 0) };
      options.forEach((opt, i) => { entry[opt] = Math.round(running[i]); });
      timeline.push(entry);
    }

    // ── Aggregates over every bet ────────────────────────────────────
    const wonBets    = allBets.filter(b => b.status === 'won');
    const lostBets   = allBets.filter(b => b.status === 'lost');
    const activeBets = allBets.filter(b => b.status === 'active');
    const refunded   = allBets.filter(b => b.status === 'refunded');
    const summary = {
      total_bets:       allBets.length,
      unique_bettors:   bettorIds.length,
      total_staked:     allBets.reduce((s, b) => s + Number(b.stake_tngn || 0), 0),
      total_net_staked: totalNetPool,
      total_paid_out:   wonBets.reduce((s, b) => s + Number(b.payout_tngn || 0), 0),
      bets_active:      activeBets.length,
      bets_won:         wonBets.length,
      bets_lost:        lostBets.length,
      bets_refunded:    refunded.length,
    };

    // Join bettor info into the bet rows for the bet-ledger table.
    const betsWithBettor = allBets.map(b => ({
      ...b,
      bettor_email: bettorsById[b.user_id]?.email ?? null,
      bettor_username: bettorsById[b.user_id]?.username ?? null,
      bettor_is_vip: !!bettorsById[b.user_id]?.is_vip,
      outcome_label: options[b.outcome_index] ?? null,
    }));

    return NextResponse.json({
      generatedAt: new Date().toISOString(),
      market: {
        ...market,
        // Stamp a friendly outcome label on the resolved index for the UI.
        resolved_outcome_label: market.resolved_outcome !== null && market.resolved_outcome !== undefined
          ? options[market.resolved_outcome] ?? null
          : null,
      },
      parent: parent.data ?? null,
      children: children.data ?? [],
      summary,
      distribution,
      timeline,
      bets: betsWithBettor,
      snapshots: snapshots.data ?? [],
      merkle: merkle.data ?? [],
    });
  } catch (e: any) {
    console.error('admin market-detail error', e);
    return NextResponse.json({ error: e?.message || 'Internal error' }, { status: 500 });
  }
}

// PATCH /api/admin/markets/[id]
//
// Mutable admin fields on a single market. Supported:
//   - is_trending (boolean)           → Trending tab curation
//   - title       (string)            → short label
//   - question    (string)            → full question text
//   - description (string|null)       → about-this-market blurb
//   - category    (string)            → top-level bucket
//   - closes_at   (ISO string)        → lock deadline
//   - options     (string[])          → outcome labels (bet-safety rules below)
//
// Options-edit rules — non-negotiable since user_bets reference outcomes
// by INDEX, not text:
//   • Rename at any existing index is fine (text-only change).
//   • Appending new options to the end is always safe — existing bets
//     keep pointing at the same indexes; we pad pool_by_outcome with 0.
//   • Removing options is allowed only when no user_bets exist on the
//     removed indexes. We check BEFORE updating and 409 otherwise so
//     a half-applied edit can't strand a bet pointing at a missing
//     option. Pool values for removed indexes get trimmed off the
//     pool_by_outcome array.
//   • Reorder is treated as a sequence of renames — admin owns the
//     semantics. We don't try to "remap" bets across positions.
//
// Pool VALUES themselves are deliberately untouched. Admins asked for
// edit power but explicitly NOT for pool tampering — leaves an audit
// trail that pool deltas can only come from real user activity.

const ALLOWED_TEXT_FIELDS = ['title', 'question', 'description', 'category'] as const;

// Bounds for locked-odds conversion. Mirror the values used at
// market-creation time (packages/app/app/api/admin/market/route.ts).
const MIN_SEED_TNGN = 1_000;
const MAX_SEED_TNGN = 14_000;
const MIN_SEED_PROB = 0.05;
const MAX_SEED_PROB = 0.95;
const MIN_VIG = 0.04;
const MAX_VIG = 0.15;

function buildSeedPoolJsonb(
  totalSeedTngn: number,
  numOutcomes: number,
  binaryYesProb: number | null,
  explicitSeedPool: number[] | null,
): Record<string, number> {
  if (explicitSeedPool && explicitSeedPool.length === numOutcomes) {
    const out: Record<string, number> = {};
    explicitSeedPool.forEach((v, i) => { out[String(i)] = Math.max(0, Math.round(Number(v) || 0)); });
    return out;
  }
  if (numOutcomes === 2 && binaryYesProb !== null) {
    const yes = Math.round(totalSeedTngn * binaryYesProb);
    return { '0': yes, '1': totalSeedTngn - yes };
  }
  const share = Math.round(totalSeedTngn / numOutcomes);
  const out: Record<string, number> = {};
  for (let i = 0; i < numOutcomes; i++) out[String(i)] = share;
  out['0'] = totalSeedTngn - share * (numOutcomes - 1);
  return out;
}

export async function PATCH(
  request: Request,
  { params }: { params: { id: string } },
) {
  if (!isAdminRequest(request)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const marketId = Number(params.id);
  if (!Number.isFinite(marketId)) {
    return NextResponse.json({ error: 'id must be a number' }, { status: 400 });
  }

  let body: any;
  try { body = await request.json(); }
  catch { return NextResponse.json({ error: 'Malformed body' }, { status: 400 }); }

  const patch: Record<string, unknown> = {};

  if (typeof body?.is_trending === 'boolean') patch.is_trending = body.is_trending;

  for (const f of ALLOWED_TEXT_FIELDS) {
    if (body[f] === undefined) continue;
    if (f === 'description' && body[f] === null) { patch[f] = null; continue; }
    const v = body[f];
    if (typeof v !== 'string') {
      return NextResponse.json({ error: `${f} must be a string` }, { status: 400 });
    }
    // Newlines/tabs preserved — admins compose multi-line questions and
    // descriptions on purpose, and the card renderer honours line breaks.
    // We trim only the leading/trailing whitespace.
    const trimmed = v.replace(/^\s+|\s+$/g, '');
    // Required-ish fields can't go empty — keeps the public list from
    // rendering blank-card-of-mystery rows.
    if ((f === 'title' || f === 'question' || f === 'category') && trimmed.length === 0) {
      return NextResponse.json({ error: `${f} cannot be empty` }, { status: 400 });
    }
    // Defensive upper bound — 10k chars is plenty for the longest
    // realistic question/description. Cap exists only to prevent abuse,
    // not to constrain editorial freedom.
    if (trimmed.length > 10_000) {
      return NextResponse.json({ error: `${f} too long (10k char max)` }, { status: 400 });
    }
    patch[f] = trimmed;
  }

  if (body.closes_at !== undefined) {
    if (typeof body.closes_at !== 'string') {
      return NextResponse.json({ error: 'closes_at must be an ISO timestamp string' }, { status: 400 });
    }
    const t = Date.parse(body.closes_at);
    if (!Number.isFinite(t)) {
      return NextResponse.json({ error: 'closes_at is not a valid timestamp' }, { status: 400 });
    }
    patch.closes_at = new Date(t).toISOString();
  }

  // Options edits require a bets-safety pre-check. We do this BEFORE
  // staging the patch so an option-removal that's blocked doesn't end
  // up mixing with successful text edits in a partial UPDATE.
  if (body.options !== undefined) {
    if (!Array.isArray(body.options)) {
      return NextResponse.json({ error: 'options must be an array' }, { status: 400 });
    }
    const newOpts = body.options.map((o: any) => (typeof o === 'string' ? o.trim() : '')).filter((s: string) => s.length > 0);
    if (newOpts.length < 2) {
      return NextResponse.json({ error: 'Need at least 2 options' }, { status: 400 });
    }
    if (newOpts.length > 50) {
      return NextResponse.json({ error: 'Maximum 50 options per market' }, { status: 400 });
    }
    if (newOpts.some((s: string) => s.length > 500)) {
      return NextResponse.json({ error: 'Each option label must be 500 chars or fewer' }, { status: 400 });
    }

    const { data: current, error: curErr } = await supabaseAdmin
      .from('markets')
      .select('options, pool_by_outcome')
      .eq('id', marketId)
      .maybeSingle();
    if (curErr) {
      return NextResponse.json({ error: curErr.message || 'Could not read market' }, { status: 500 });
    }
    if (!current) return NextResponse.json({ error: 'Market not found' }, { status: 404 });

    const oldOpts: string[] = Array.isArray(current.options) ? current.options : [];
    const oldPool: number[] = Array.isArray(current.pool_by_outcome) ? current.pool_by_outcome : [];

    // If shrinking, ensure no bets reference the removed indexes.
    if (newOpts.length < oldOpts.length) {
      const { data: blockingBets, error: betsErr } = await supabaseAdmin
        .from('user_bets')
        .select('outcome_index')
        .eq('market_id', marketId)
        .gte('outcome_index', newOpts.length)
        .limit(1);
      if (betsErr) {
        return NextResponse.json({ error: betsErr.message || 'Could not check bets' }, { status: 500 });
      }
      if (blockingBets && blockingBets.length > 0) {
        return NextResponse.json({
          error: 'Cannot remove an option that has stakes on it. Rename instead, or wait until resolution.',
        }, { status: 409 });
      }
    }

    // Resize the per-outcome pool to match new options length. Append 0s
    // for new outcomes, drop trailing entries for removed outcomes (only
    // reachable after the bet-safety check above, so the dropped pool
    // values are guaranteed to be 0).
    const newPool = [...oldPool.slice(0, newOpts.length)];
    while (newPool.length < newOpts.length) newPool.push(0);

    patch.options = newOpts;
    patch.pool_by_outcome = newPool;
  }

  // ── Convert legacy parimutuel market → locked-odds ───────────────
  // Old markets created before the locked-odds engine still settle
  // through the parimutuel path. Admin can selectively migrate one
  // here. Hard constraints (not negotiable):
  //   • Market must currently be parimutuel (is_locked_odds = false).
  //   • Market must be open (post-lock markets are sealed).
  //   • Market must have zero bets — converting in-flight bets would
  //     either strand them (no locked_odds row) or rewrite the price
  //     they agreed to. We refuse rather than guess.
  //   • Seed must fit the deployable reserve (same rule as create).
  //
  // Conversion mutates: is_locked_odds, seed_pool, seed_probability,
  // vig_pct, is_paused. Everything else stays put.
  if (body.convertToLockedOdds && typeof body.convertToLockedOdds === 'object') {
    const cfg = body.convertToLockedOdds as {
      seedSizeTngn?: number | string;
      seedPool?: number[] | null;
      seedProbability?: number | null;
      vigPct?: number | string | null;
    };

    const seedSize = Number(cfg.seedSizeTngn);
    if (!Number.isFinite(seedSize) || seedSize < MIN_SEED_TNGN || seedSize > MAX_SEED_TNGN) {
      return NextResponse.json(
        { error: `Seed size must be between ₦${MIN_SEED_TNGN.toLocaleString()} and ₦${MAX_SEED_TNGN.toLocaleString()} tNGN` },
        { status: 400 },
      );
    }

    const { data: m, error: mErr } = await supabaseAdmin
      .from('markets')
      .select('id, is_locked_odds, status, options')
      .eq('id', marketId)
      .maybeSingle();
    if (mErr) return NextResponse.json({ error: mErr.message || 'Could not read market' }, { status: 500 });
    if (!m) return NextResponse.json({ error: 'Market not found' }, { status: 404 });
    if (m.is_locked_odds) {
      return NextResponse.json({ error: 'Market is already locked-odds' }, { status: 409 });
    }
    if (m.status !== 'open') {
      return NextResponse.json(
        { error: `Cannot convert a ${m.status} market — locked-odds requires status=open.` },
        { status: 409 },
      );
    }

    const opts: string[] = Array.isArray(m.options) ? m.options : [];
    if (opts.length < 2) {
      return NextResponse.json({ error: 'Market needs at least 2 options before conversion' }, { status: 400 });
    }

    const { count: existingBets, error: betsErr } = await supabaseAdmin
      .from('user_bets')
      .select('id', { count: 'exact', head: true })
      .eq('market_id', marketId);
    if (betsErr) return NextResponse.json({ error: betsErr.message || 'Could not count bets' }, { status: 500 });
    if ((existingBets ?? 0) > 0) {
      return NextResponse.json(
        { error: `Cannot convert: ${existingBets} bet(s) already placed. Conversion is only allowed on markets with zero stakes.` },
        { status: 409 },
      );
    }

    let binaryProb: number | null = null;
    if (opts.length === 2) {
      if (cfg.seedProbability !== undefined && cfg.seedProbability !== null) {
        const p = Number(cfg.seedProbability);
        if (!Number.isFinite(p) || p < MIN_SEED_PROB || p > MAX_SEED_PROB) {
          return NextResponse.json(
            { error: `Seed probability must be between ${MIN_SEED_PROB} and ${MAX_SEED_PROB}` },
            { status: 400 },
          );
        }
        binaryProb = p;
      } else {
        binaryProb = 0.5;
      }
    }

    const explicit = Array.isArray(cfg.seedPool)
      ? cfg.seedPool.map(Number).filter(v => Number.isFinite(v))
      : null;

    const { data: reserve } = await supabaseAdmin
      .from('reserve_health')
      .select('deployable_tngn')
      .maybeSingle();
    const deployable = Number(reserve?.deployable_tngn ?? 0);
    if (seedSize > deployable) {
      return NextResponse.json(
        { error: `Seed of ₦${seedSize.toLocaleString()} exceeds deployable reserve of ₦${Math.round(deployable).toLocaleString()}` },
        { status: 400 },
      );
    }

    let resolvedVig = 0.08;
    if (cfg.vigPct !== undefined && cfg.vigPct !== null && cfg.vigPct !== '') {
      const v = Number(cfg.vigPct);
      if (!Number.isFinite(v) || v < MIN_VIG || v > MAX_VIG) {
        return NextResponse.json(
          { error: 'Vig must be between 0.04 (4%) and 0.15 (15%)' },
          { status: 400 },
        );
      }
      resolvedVig = v;
    }

    patch.is_locked_odds = true;
    patch.seed_pool = buildSeedPoolJsonb(
      seedSize,
      opts.length,
      binaryProb,
      explicit && explicit.length === opts.length ? explicit : null,
    );
    patch.seed_probability = binaryProb;
    patch.vig_pct = resolvedVig;
    patch.is_paused = false;
  }

  if (Object.keys(patch).length === 0) {
    return NextResponse.json({ error: 'No supported fields in body' }, { status: 400 });
  }

  const { data, error } = await supabaseAdmin
    .from('markets')
    .update(patch)
    .eq('id', marketId)
    .select('id, is_trending, title, question, description, category, closes_at, options, pool_by_outcome, is_locked_odds, seed_pool, vig_pct')
    .maybeSingle();

  if (error) {
    console.error('admin market-patch error', error);
    return NextResponse.json({ error: error.message || 'Update failed' }, { status: 500 });
  }
  if (!data) return NextResponse.json({ error: 'Market not found' }, { status: 404 });

  return NextResponse.json({ ok: true, market: data });
}

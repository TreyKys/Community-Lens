import { NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { isAdminRequest } from '@/lib/adminAuth';
import { fetchStatsAPIMatch } from '@/lib/oracle';

const supabaseAdmin = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

/**
 * GET /api/admin/diagnose-result?marketId=123
 *
 * Shows what each API source returns for a market's fixture, side-by-side.
 * Useful for debugging when a match isn't resolving or resolving incorrectly.
 */
export async function GET(request: Request) {
  if (!isAdminRequest(request)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const url = new URL(request.url);
  const marketId = url.searchParams.get('marketId');
  if (!marketId) {
    return NextResponse.json({ error: 'Missing marketId param' }, { status: 400 });
  }

  const { data: market, error } = await supabaseAdmin
    .from('markets')
    .select('id, title, fixture_id, sport, options, status, resolved_outcome, resolution_attempts, closes_at, home_team, away_team')
    .eq('id', marketId)
    .single();

  if (error || !market) {
    return NextResponse.json({ error: 'Market not found' }, { status: 404 });
  }

  const diagnostics: any = {
    market: {
      id: market.id,
      title: market.title,
      fixture_id: market.fixture_id,
      sport: market.sport,
      status: market.status,
      resolved_outcome: market.resolved_outcome,
      resolution_attempts: market.resolution_attempts,
      closes_at: market.closes_at,
      home_team: (market as any).home_team,
      away_team: (market as any).away_team,
      options: market.options,
    },
    sources: {} as Record<string, any>,
  };

  if (!market.fixture_id) {
    diagnostics.error = 'No fixture_id on this market — cannot auto-resolve';
    return NextResponse.json(diagnostics);
  }

  // Source 1: football-data.org
  try {
    const fdaKey = process.env.FOOTBALL_DATA_API_KEY;
    if (!fdaKey) {
      diagnostics.sources.fda = { error: 'FOOTBALL_DATA_API_KEY not set' };
    } else {
      const res = await fetch(
        `https://api.football-data.org/v4/matches/${market.fixture_id}`,
        { headers: { 'X-Auth-Token': fdaKey } }
      );
      if (!res.ok) {
        const body = await res.text().catch(() => '');
        diagnostics.sources.fda = {
          http_status: res.status,
          body_excerpt: body.slice(0, 300),
        };
      } else {
        const d = await res.json();
        diagnostics.sources.fda = {
          status: d.status,
          home_team: d.homeTeam?.name,
          away_team: d.awayTeam?.name,
          home_score: d.score?.fullTime?.home,
          away_score: d.score?.fullTime?.away,
          winner_field: d.score?.winner,
          calculated_outcome: calc(d.score?.fullTime?.home, d.score?.fullTime?.away),
        };
      }
    }
  } catch (e: any) {
    diagnostics.sources.fda = { error: e?.message || String(e) };
  }

  // Source 2: StatsAPI (search by team names + date)
  try {
    const statsKey = process.env.STATSAPI_KEY;
    const homeTeam = (market as any).home_team;
    const awayTeam = (market as any).away_team;
    if (!statsKey) {
      diagnostics.sources.statsapi = { error: 'STATSAPI_KEY not set' };
    } else if (!homeTeam || !awayTeam || !market.closes_at) {
      diagnostics.sources.statsapi = { error: 'Market missing home_team, away_team, or closes_at' };
    } else {
      const result = await fetchStatsAPIMatch({ homeTeam, awayTeam, closesAt: market.closes_at });
      if (!result.ok) {
        diagnostics.sources.statsapi = {
          error: `lookup_failed: ${result.reason}`,
          matches_scanned: result.matchesScanned,
        };
      } else {
        const data = result.match;
        const flipped = data._orientation === 'flipped';
        const home = flipped ? data.score?.away : data.score?.home;
        const away = flipped ? data.score?.home : data.score?.away;
        diagnostics.sources.statsapi = {
          status: data.status,
          orientation: data._orientation,
          stats_home_team: data.home_team?.name,
          stats_away_team: data.away_team?.name,
          home_score: home,
          away_score: away,
          calculated_outcome: calc(home, away),
        };
      }
    }
  } catch (e: any) {
    diagnostics.sources.statsapi = { error: e?.message || String(e) };
  }

  // Recommendation
  const fdaOutcome = diagnostics.sources.fda?.calculated_outcome;
  const statsOutcome = diagnostics.sources.statsapi?.calculated_outcome;
  if (fdaOutcome !== undefined && statsOutcome !== undefined && fdaOutcome === statsOutcome) {
    diagnostics.recommendation = `Both sources agree: outcome=${fdaOutcome} (${market.options[fdaOutcome]})`;
  } else if (fdaOutcome !== undefined && statsOutcome === undefined) {
    diagnostics.recommendation = `Only FDA has result: outcome=${fdaOutcome} (${market.options[fdaOutcome]})`;
  } else if (statsOutcome !== undefined && fdaOutcome === undefined) {
    diagnostics.recommendation = `Only StatsAPI has result: outcome=${statsOutcome} (${market.options[statsOutcome]})`;
  } else if (fdaOutcome !== statsOutcome && fdaOutcome !== undefined && statsOutcome !== undefined) {
    diagnostics.recommendation = `CONFLICT — FDA=${fdaOutcome} StatsAPI=${statsOutcome}. Manual review needed.`;
  } else {
    diagnostics.recommendation = 'No source has a finished result yet';
  }

  return NextResponse.json(diagnostics);
}

function calc(home: number | null | undefined, away: number | null | undefined): number | undefined {
  if (home == null || away == null) return undefined;
  if (home > away) return 0;
  if (home === away) return 1;
  return 2;
}

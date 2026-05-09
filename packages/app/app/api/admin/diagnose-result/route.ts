import { NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { isAdminRequest } from '@/lib/adminAuth';
import { fetchRapidAPIFootballResult } from '@/lib/oracle';

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
    .select('id, title, fixture_id, sport, options, status, resolved_outcome, resolution_attempts, closes_at')
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

  // Source 2: RapidAPI football
  try {
    const rapidKey = process.env.RAPIDAPI_KEY;
    if (!rapidKey) {
      diagnostics.sources.rapidapi = { error: 'RAPIDAPI_KEY not set' };
    } else {
      const data = await fetchRapidAPIFootballResult(market.fixture_id);
      if (!data) {
        diagnostics.sources.rapidapi = { error: 'No data returned (check logs)' };
      } else {
        diagnostics.sources.rapidapi = {
          status: data.fixture?.status?.long || data.fixture?.status?.short || data.fixture?.status,
          home_team: data.teams?.home?.name,
          away_team: data.teams?.away?.name,
          home_score: data.goals?.home,
          away_score: data.goals?.away,
          calculated_outcome: calc(data.goals?.home, data.goals?.away),
        };
      }
    }
  } catch (e: any) {
    diagnostics.sources.rapidapi = { error: e?.message || String(e) };
  }

  // Recommendation
  const fdaOutcome = diagnostics.sources.fda?.calculated_outcome;
  const rapidOutcome = diagnostics.sources.rapidapi?.calculated_outcome;
  if (fdaOutcome !== undefined && rapidOutcome !== undefined && fdaOutcome === rapidOutcome) {
    diagnostics.recommendation = `Both sources agree: outcome=${fdaOutcome} (${market.options[fdaOutcome]})`;
  } else if (fdaOutcome !== undefined && rapidOutcome === undefined) {
    diagnostics.recommendation = `Only FDA has result: outcome=${fdaOutcome} (${market.options[fdaOutcome]})`;
  } else if (rapidOutcome !== undefined && fdaOutcome === undefined) {
    diagnostics.recommendation = `Only RapidAPI has result: outcome=${rapidOutcome} (${market.options[rapidOutcome]})`;
  } else if (fdaOutcome !== rapidOutcome) {
    diagnostics.recommendation = `CONFLICT — FDA=${fdaOutcome} RapidAPI=${rapidOutcome}. Manual review needed.`;
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

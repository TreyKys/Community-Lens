import { createClient, SupabaseClient } from '@supabase/supabase-js';

export function getSupabaseAdmin(): SupabaseClient {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!
  );
}

export function getBaseUrl() {
  return process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000';
}

export function cronHeaders() {
  return {
    'Content-Type': 'application/json',
    'x-cron-secret': process.env.CRON_SECRET!,
  };
}

// ── SPORT DATA PROVIDERS ──────────────────────────────────────────────────
export const FOOTBALL_LEAGUES = ['PL', 'CL', 'PD', 'SA', 'BL1', 'FL1', 'DED', 'PPL', 'BSA', 'EC', 'WC', 'ELC'];

export const BASKETBALL_LEAGUES: { code: string; apiSportsId: number }[] = [
  { code: 'NBA', apiSportsId: 12 },
  { code: 'EUROLEAGUE', apiSportsId: 120 },
];

// PandaScore videogame slug → short code we render and filter on.
export const ESPORTS_GAME_CODES: Record<string, string> = {
  'league-of-legends': 'LOL',
  'lol': 'LOL',
  'cs-go': 'CSGO',
  'csgo': 'CSGO',
  'cs2': 'CSGO',
  'dota-2': 'DOTA2',
  'dota2': 'DOTA2',
  'valorant': 'VAL',
  'rainbow-six-siege': 'R6S',
  'r6-siege': 'R6S',
};

export function esportsGameCode(slug: string | undefined | null, fallbackName?: string | null): string {
  if (slug && ESPORTS_GAME_CODES[slug]) return ESPORTS_GAME_CODES[slug];
  const name = (fallbackName || slug || 'ESPORTS').toString().toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6);
  return name || 'ESPORTS';
}

export async function fetchFootballFixtures(competitionCode: string): Promise<any[]> {
  const apiKey = process.env.FOOTBALL_DATA_API_KEY;
  if (!apiKey) {
    console.warn(`[seed] football-data: FOOTBALL_DATA_API_KEY not set, skipping ${competitionCode}`);
    return [];
  }
  const dateFrom = new Date().toISOString().split('T')[0];
  const dateTo = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
  try {
    const res = await fetch(
      `https://api.football-data.org/v4/competitions/${competitionCode}/matches?dateFrom=${dateFrom}&dateTo=${dateTo}&status=SCHEDULED`,
      { headers: { 'X-Auth-Token': apiKey } }
    );
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      console.error(`[seed] football-data ${competitionCode} HTTP ${res.status}: ${body.slice(0, 200)}`);
      return [];
    }
    const data = await res.json();
    return data.matches || [];
  } catch (err: any) {
    console.error(`[seed] football-data ${competitionCode} threw:`, err?.message || err);
    return [];
  }
}

export async function fetchApiSportsFixtures(sport: string, leagueId: number): Promise<any[]> {
  const apiKey = process.env.API_SPORTS_KEY;
  if (!apiKey) {
    console.warn(`[seed] api-sports: API_SPORTS_KEY not set, skipping ${sport}/${leagueId}`);
    return [];
  }
  const host = sport === 'basketball' ? 'api-basketball.p.rapidapi.com' : 'api-tennis.p.rapidapi.com';
  const season = new Date().getFullYear();
  const endpoint = sport === 'basketball'
    ? `https://${host}/games?league=${leagueId}&season=${season}`
    : `https://${host}/matches?league_id=${leagueId}&season=${season}`;
  try {
    const res = await fetch(endpoint, {
      headers: { 'X-RapidAPI-Key': apiKey, 'X-RapidAPI-Host': host }
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      console.error(`[seed] api-sports ${sport}/${leagueId} HTTP ${res.status}: ${body.slice(0, 200)}`);
      return [];
    }
    const data = await res.json();
    return data.response || [];
  } catch (err: any) {
    console.error(`[seed] api-sports ${sport}/${leagueId} threw:`, err?.message || err);
    return [];
  }
}

export async function fetchEsportsFixtures(): Promise<any[]> {
  const apiKey = process.env.PANDASCORE_API_KEY;
  if (!apiKey) {
    console.warn('[seed] pandascore: PANDASCORE_API_KEY not set, skipping esports');
    return [];
  }
  try {
    const res = await fetch(
      'https://api.pandascore.co/matches/upcoming?per_page=10&sort=begin_at',
      { headers: { Authorization: `Bearer ${apiKey}` } }
    );
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      console.error(`[seed] pandascore HTTP ${res.status}: ${body.slice(0, 200)}`);
      return [];
    }
    return await res.json();
  } catch (err: any) {
    console.error('[seed] pandascore threw:', err?.message || err);
    return [];
  }
}

// Normalize team names so "Manchester United FC" matches "Man United".
function normalizeTeamName(name: string | null | undefined): string {
  if (!name) return '';
  return name.toLowerCase()
    .replace(/\b(fc|afc|cf|sc|ac|football club)\b/g, '')
    .replace(/[^a-z0-9 ]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function teamsMatch(a: string, b: string): boolean {
  const na = normalizeTeamName(a);
  const nb = normalizeTeamName(b);
  if (!na || !nb) return false;
  if (na === nb) return true;
  // Token-overlap: at least 50% of tokens shared (handles "Man United" vs "Manchester United")
  const ta = new Set(na.split(' ').filter(Boolean));
  const tb = new Set(nb.split(' ').filter(Boolean));
  if (ta.size === 0 || tb.size === 0) return false;
  let shared = 0;
  for (const t of Array.from(ta)) if (tb.has(t)) shared++;
  return shared / Math.min(ta.size, tb.size) >= 0.5;
}

// Search StatsAPI for a finished match given home/away names + a date hint.
export async function fetchStatsAPIMatch(opts: {
  homeTeam: string;
  awayTeam: string;
  closesAt: string; // ISO date — kickoff time
}): Promise<any | null> {
  const apiKey = process.env.STATSAPI_KEY;
  if (!apiKey) {
    console.warn('[result] statsapi: STATSAPI_KEY not set');
    return null;
  }
  try {
    const kickoff = new Date(opts.closesAt);
    // Look ±1 day around kickoff to handle timezone slop and late finishes.
    const dateFrom = new Date(kickoff.getTime() - 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    const dateTo = new Date(kickoff.getTime() + 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

    const res = await fetch(
      `https://api.thestatsapi.com/api/football/matches?status=finished&date_from=${dateFrom}&date_to=${dateTo}&per_page=100`,
      { headers: { Authorization: `Bearer ${apiKey}` } }
    );
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      console.error(`[result] statsapi HTTP ${res.status}: ${body.slice(0, 200)}`);
      return null;
    }
    const data = await res.json();
    const matches: any[] = data?.data || [];

    // Find the match with both teams matching (in either home/away orientation).
    const targetHome = opts.homeTeam;
    const targetAway = opts.awayTeam;
    for (const m of matches) {
      const mh = m.home_team?.name;
      const ma = m.away_team?.name;
      if (teamsMatch(mh, targetHome) && teamsMatch(ma, targetAway)) {
        return { ...m, _orientation: 'normal' };
      }
      // Sometimes home/away are swapped between providers — handle that too.
      if (teamsMatch(mh, targetAway) && teamsMatch(ma, targetHome)) {
        return { ...m, _orientation: 'flipped' };
      }
    }
    return null;
  } catch (err: any) {
    console.error('[result] statsapi threw:', err?.message || err);
    return null;
  }
}

// Helper: verify football result from scores (not relying on a single 'winner' field)
function calculateOutcomeFromScores(homeScore: number | null, awayScore: number | null): number | null {
  if (homeScore === null || awayScore === null) return null;
  if (homeScore > awayScore) return 0; // Home Win
  if (homeScore === awayScore) return 1; // Draw
  return 2; // Away Win
}

async function lookupFootballResultFDA(fixtureId: number): Promise<{
  found: boolean;
  outcomeIndex: number | null;
  reason: string;
}> {
  const key = process.env.FOOTBALL_DATA_API_KEY;
  if (!key) {
    return { found: false, outcomeIndex: null, reason: 'no_fda_key' };
  }
  try {
    const res = await fetch(
      `https://api.football-data.org/v4/matches/${fixtureId}`,
      { headers: { 'X-Auth-Token': key } }
    );
    if (!res.ok) {
      const status = res.status;
      if (status === 429) return { found: false, outcomeIndex: null, reason: 'fda_rate_limit' };
      if (status >= 500) return { found: false, outcomeIndex: null, reason: 'fda_server_error' };
      return { found: false, outcomeIndex: null, reason: `fda_http_${status}` };
    }
    const d = await res.json();
    if (d.status !== 'FINISHED') {
      return { found: false, outcomeIndex: null, reason: `fda_status_${d.status}` };
    }

    // Prefer calculating from scores to avoid single 'winner' field issues
    const homeScore = d.score?.fullTime?.home;
    const awayScore = d.score?.fullTime?.away;
    const outcomeIndex = calculateOutcomeFromScores(homeScore, awayScore);

    if (outcomeIndex !== null) {
      console.log(`[lookup] FDA verified fixture ${fixtureId}: home=${homeScore} away=${awayScore} outcome=${outcomeIndex}`);
      return { found: true, outcomeIndex, reason: 'fda_score_verified' };
    }

    // Fallback: try the 'winner' field if scores aren't available
    const map: Record<string, number> = { HOME_TEAM: 0, DRAW: 1, AWAY_TEAM: 2 };
    const winnerOutcome = map[d.score?.winner] ?? null;
    if (winnerOutcome !== null) {
      console.log(`[lookup] FDA verified fixture ${fixtureId} via winner field: ${d.score?.winner}`);
      return { found: true, outcomeIndex: winnerOutcome, reason: 'fda_winner_verified' };
    }

    return { found: false, outcomeIndex: null, reason: 'fda_no_result' };
  } catch (err: any) {
    console.error(`[lookup] FDA threw for fixture ${fixtureId}:`, err?.message || err);
    return { found: false, outcomeIndex: null, reason: `fda_error_${err?.message}` };
  }
}

async function lookupFootballResultStatsAPI(opts: {
  homeTeam: string | null;
  awayTeam: string | null;
  closesAt: string | null;
}): Promise<{
  found: boolean;
  outcomeIndex: number | null;
  reason: string;
}> {
  if (!opts.homeTeam || !opts.awayTeam || !opts.closesAt) {
    return { found: false, outcomeIndex: null, reason: 'statsapi_missing_team_or_date' };
  }
  const match = await fetchStatsAPIMatch({
    homeTeam: opts.homeTeam,
    awayTeam: opts.awayTeam,
    closesAt: opts.closesAt,
  });
  if (!match) {
    return { found: false, outcomeIndex: null, reason: 'statsapi_no_match_found' };
  }
  if (match.status !== 'finished') {
    return { found: false, outcomeIndex: null, reason: `statsapi_status_${match.status}` };
  }

  let homeScore = match.score?.home;
  let awayScore = match.score?.away;
  // If StatsAPI has the orientation flipped, swap scores so they align with our home/away.
  if (match._orientation === 'flipped') {
    [homeScore, awayScore] = [awayScore, homeScore];
  }

  const outcomeIndex = calculateOutcomeFromScores(homeScore, awayScore);
  if (outcomeIndex !== null) {
    console.log(`[lookup] StatsAPI verified ${opts.homeTeam} vs ${opts.awayTeam}: home=${homeScore} away=${awayScore} outcome=${outcomeIndex} (orientation=${match._orientation})`);
    return { found: true, outcomeIndex, reason: 'statsapi_verified' };
  }
  return { found: false, outcomeIndex: null, reason: 'statsapi_no_score' };
}

export async function createMarketIfNotExists(params: {
  question: string; category: string; sport: string;
  options: string[]; closesAt: string; fixtureId: number | null;
  homeTeam: string; awayTeam: string; leagueCode: string;
  parentMarketId?: number;
}): Promise<{ skipped?: boolean; success?: boolean; error?: string; marketId?: number }> {
  const supabaseAdmin = getSupabaseAdmin();
  const baseUrl = getBaseUrl();
  const adminSecret = process.env.ADMIN_SECRET;

  if (params.fixtureId && !params.parentMarketId) {
    const { data } = await supabaseAdmin
      .from('markets')
      .select('id')
      .eq('fixture_id', params.fixtureId)
      .is('parent_market_id', null)
      .single();
    if (data) return { skipped: true };
  }

  const res = await fetch(`${baseUrl}/api/admin/market`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${adminSecret}` },
    body: JSON.stringify({
      question: params.question,
      title: params.question,
      category: params.category,
      sport: params.sport,
      options: params.options,
      closesAt: params.closesAt,
      fixtureId: params.fixtureId,
      homeTeam: params.homeTeam,
      awayTeam: params.awayTeam,
      leagueCode: params.leagueCode,
      parentMarketId: params.parentMarketId || null,
    }),
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: 'unknown' }));
    return { success: false, error: err.error };
  }

  const { market } = await res.json();
  return { success: true, marketId: market.id };
}

// Core market-result lookup by sport. Returns winningOutcomeIndex (0-based) or null.
export async function lookupMarketResult(
  market: {
    id: number;
    sport: string | null;
    fixture_id: number | null;
    options: string[];
    home_team?: string | null;
    away_team?: string | null;
    closes_at?: string | null;
  }
): Promise<{ winningOutcomeIndex: number | null; reason?: string }> {
  const sport = market.sport || 'football';

  try {
    if (sport === 'football') {
      // Try football-data.org first (it has the matching fixture_id)
      let result = await lookupFootballResultFDA(market.fixture_id!);
      if (!result.found) {
        console.warn(`[lookup] FDA failed for market ${market.id} (${result.reason}), trying StatsAPI by team names`);
        // StatsAPI doesn't share fixture IDs with FDA — search by team names + date.
        result = await lookupFootballResultStatsAPI({
          homeTeam: market.home_team || null,
          awayTeam: market.away_team || null,
          closesAt: market.closes_at || null,
        });
      }
      return { winningOutcomeIndex: result.outcomeIndex, reason: result.reason };
    }

    if (sport === 'basketball' || sport === 'tennis') {
      const key = process.env.API_SPORTS_KEY;
      if (!key) return { winningOutcomeIndex: null, reason: 'no_api_sports_key' };
      const host = sport === 'basketball' ? 'api-basketball.p.rapidapi.com' : 'api-tennis.p.rapidapi.com';
      const url = sport === 'basketball'
        ? `https://${host}/games?id=${market.fixture_id}`
        : `https://${host}/matches/${market.fixture_id}`;
      const res = await fetch(url, {
        headers: { 'X-RapidAPI-Key': key, 'X-RapidAPI-Host': host }
      });
      if (!res.ok) return { winningOutcomeIndex: null, reason: `api_sports_${res.status}` };
      const d = await res.json();
      const game = d.response?.[0];
      if (!game) return { winningOutcomeIndex: null, reason: 'no_data' };
      const finished = ['FT', 'AOT', 'Finished'].includes(game.status?.short || game.status);
      if (!finished) return { winningOutcomeIndex: null, reason: 'not_finished' };
      const homeScore = game.scores?.home?.total ?? 0;
      const awayScore = game.scores?.away?.total ?? 0;
      return { winningOutcomeIndex: homeScore > awayScore ? 0 : 1 };
    }

    if (sport === 'esports') {
      const key = process.env.PANDASCORE_API_KEY;
      if (!key) return { winningOutcomeIndex: null, reason: 'no_pandascore_key' };
      const res = await fetch(`https://api.pandascore.co/matches/${market.fixture_id}`, {
        headers: { Authorization: `Bearer ${key}` }
      });
      if (!res.ok) return { winningOutcomeIndex: null, reason: `pandascore_${res.status}` };
      const m = await res.json();
      if (m.status !== 'finished') return { winningOutcomeIndex: null, reason: m.status };
      const winner = m.winner?.name;
      const idx = market.options.findIndex(
        (o) => o.toLowerCase().includes((winner || '').toLowerCase())
      );
      return { winningOutcomeIndex: idx >= 0 ? idx : null };
    }
  } catch (e: any) {
    return { winningOutcomeIndex: null, reason: e.message };
  }

  return { winningOutcomeIndex: null, reason: 'unsupported_sport' };
}

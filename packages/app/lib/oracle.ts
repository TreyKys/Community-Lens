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
export const FOOTBALL_LEAGUES = ['PL', 'CL', 'PD', 'SA', 'BL1', 'FL1', 'DED', 'PPL', 'BSA', 'EC', 'WC'];

export async function fetchFootballFixtures(competitionCode: string): Promise<any[]> {
  const apiKey = process.env.FOOTBALL_DATA_API_KEY;
  if (!apiKey) return [];
  const dateFrom = new Date().toISOString().split('T')[0];
  const dateTo = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
  try {
    const res = await fetch(
      `https://api.football-data.org/v4/competitions/${competitionCode}/matches?dateFrom=${dateFrom}&dateTo=${dateTo}&status=SCHEDULED`,
      { headers: { 'X-Auth-Token': apiKey } }
    );
    if (!res.ok) return [];
    const data = await res.json();
    return data.matches || [];
  } catch { return []; }
}

export async function fetchApiSportsFixtures(sport: string, leagueId: number): Promise<any[]> {
  const apiKey = process.env.API_SPORTS_KEY;
  if (!apiKey) return [];
  const host = sport === 'basketball' ? 'api-basketball.p.rapidapi.com' : 'api-tennis.p.rapidapi.com';
  const season = new Date().getFullYear();
  const endpoint = sport === 'basketball'
    ? `https://${host}/games?league=${leagueId}&season=${season}`
    : `https://${host}/matches?league_id=${leagueId}&season=${season}`;
  try {
    const res = await fetch(endpoint, {
      headers: { 'X-RapidAPI-Key': apiKey, 'X-RapidAPI-Host': host }
    });
    if (!res.ok) return [];
    const data = await res.json();
    return data.response || [];
  } catch { return []; }
}

export async function fetchEsportsFixtures(): Promise<any[]> {
  const apiKey = process.env.PANDASCORE_API_KEY;
  if (!apiKey) return [];
  try {
    const res = await fetch(
      'https://api.pandascore.co/matches/upcoming?per_page=10&sort=begin_at',
      { headers: { Authorization: `Bearer ${apiKey}` } }
    );
    if (!res.ok) return [];
    return await res.json();
  } catch { return []; }
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
  market: { id: number; sport: string | null; fixture_id: number | null; options: string[] }
): Promise<{ winningOutcomeIndex: number | null; reason?: string }> {
  const sport = market.sport || 'football';

  try {
    if (sport === 'football') {
      const key = process.env.FOOTBALL_DATA_API_KEY;
      if (!key) return { winningOutcomeIndex: null, reason: 'no_key' };
      const res = await fetch(
        `https://api.football-data.org/v4/matches/${market.fixture_id}`,
        { headers: { 'X-Auth-Token': key } }
      );
      if (!res.ok) return { winningOutcomeIndex: null, reason: `api_${res.status}` };
      const d = await res.json();
      if (d.status !== 'FINISHED') return { winningOutcomeIndex: null, reason: d.status };
      const map: Record<string, number> = { HOME_TEAM: 0, DRAW: 1, AWAY_TEAM: 2 };
      return { winningOutcomeIndex: map[d.score?.winner] ?? null };
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

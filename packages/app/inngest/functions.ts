import { inngest } from './client';
import { createClient } from '@supabase/supabase-js';

function getSupabaseAdmin() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!
  );
}

function getBaseUrl() {
  return process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000';
}

function cronHeaders() {
  return {
    'Content-Type': 'application/json',
    'x-cron-secret': process.env.CRON_SECRET!,
  };
}

// ── SPORT DATA PROVIDERS ──────────────────────────────────────────────────
// football-data.org  → Football (free tier, 10 req/min)
// API-Sports         → Basketball, Tennis (RapidAPI hub, ~$10/mo)
// PandaScore         → eSports (free tier 1000 req/mo)

const FOOTBALL_LEAGUES = ['PL', 'CL', 'PD', 'SA', 'BL1', 'FL1'];

async function fetchFootballFixtures(competitionCode: string): Promise<any[]> {
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

async function fetchApiSportsFixtures(sport: string, leagueId: number): Promise<any[]> {
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

async function fetchEsportsFixtures(): Promise<any[]> {
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

async function createMarketIfNotExists(params: {
  question: string; category: string; sport: string;
  options: string[]; closesAt: string; fixtureId: number | null;
  homeTeam: string; awayTeam: string; leagueCode: string;
  parentMarketId?: number;
}) {
  const supabaseAdmin = getSupabaseAdmin();
  const baseUrl = getBaseUrl();
  const adminSecret = process.env.ADMIN_SECRET;

  // Idempotency: skip if fixture already exists as a top-level market
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
    const err = await res.json();
    return { skipped: false, success: false, error: err.error };
  }

  const { market } = await res.json();
  return { skipped: false, success: true, marketId: market.id };
}

// ═══════════════════════════════════════════════════════════
// 1. DAILY MARKET CREATION (6am UTC daily)
// ═══════════════════════════════════════════════════════════
export const dailyMarketCreation = inngest.createFunction(
  { id: 'daily-market-creation', name: 'Daily Market Creation' },
  { cron: '0 6 * * *' },
  async ({ step }) => {
    const results: any[] = [];

    // Football leagues
    for (const code of FOOTBALL_LEAGUES) {
      const fixtures = await step.run(`fetch-${code}`, () => fetchFootballFixtures(code));
      for (const match of fixtures) {
        const r = await step.run(`create-football-${match.id}`, async () => {
          const home = match.homeTeam?.shortName || match.homeTeam?.name || 'Home';
          const away = match.awayTeam?.shortName || match.awayTeam?.name || 'Away';
          const kickoff = new Date(match.utcDate).toISOString();
          const parent = await createMarketIfNotExists({
            question: `[${code}] ${home} vs ${away} — Match Winner`,
            category: 'sports', sport: 'football',
            options: ['Home Win', 'Draw', 'Away Win'],
            closesAt: kickoff, fixtureId: match.id,
            homeTeam: home, awayTeam: away, leagueCode: code,
          });
          if (!parent.success || parent.skipped) return parent;
          // Sub-markets
          const subs = [
            { q: `[${code}] ${home} vs ${away} (BTTS)`, opts: ['Yes - Both Score', 'No - Both Score'] },
            { q: `[${code}] ${home} vs ${away} (Over/Under 2.5)`, opts: ['Over 2.5 Goals', 'Under 2.5 Goals'] },
          ];
          for (const sub of subs) {
            await createMarketIfNotExists({
              question: sub.q, category: 'sports', sport: 'football',
              options: sub.opts, closesAt: kickoff, fixtureId: match.id,
              homeTeam: home, awayTeam: away, leagueCode: code,
              parentMarketId: parent.marketId,
            });
          }
          return { ...parent, question: `${home} vs ${away}` };
        });
        results.push(r);
      }
    }

    // Basketball (NBA)
    const nbaGames = await step.run('fetch-nba', () => fetchApiSportsFixtures('basketball', 12));
    for (const g of nbaGames.slice(0, 10)) {
      const r = await step.run(`create-nba-${g.id}`, async () => {
        const home = g.teams?.home?.name || 'Home';
        const away = g.teams?.away?.name || 'Away';
        return createMarketIfNotExists({
          question: `[NBA] ${away} @ ${home} — Winner`,
          category: 'sports', sport: 'basketball',
          options: [`${home} Win`, `${away} Win`],
          closesAt: new Date(g.date).toISOString(),
          fixtureId: g.id, homeTeam: home, awayTeam: away, leagueCode: 'NBA',
        });
      });
      results.push(r);
    }

    // eSports (PandaScore)
    const esMatches = await step.run('fetch-esports', fetchEsportsFixtures);
    for (const m of esMatches.slice(0, 5)) {
      const r = await step.run(`create-esports-${m.id}`, async () => {
        if (!m.opponents || m.opponents.length < 2) return { skipped: true };
        const t1 = m.opponents[0]?.opponent?.name || 'Team 1';
        const t2 = m.opponents[1]?.opponent?.name || 'Team 2';
        const game = m.videogame?.name || 'eSports';
        return createMarketIfNotExists({
          question: `[${game}] ${t1} vs ${t2} — Winner`,
          category: 'sports', sport: 'esports',
          options: [`${t1} Win`, `${t2} Win`],
          closesAt: new Date(m.begin_at || m.scheduled_at).toISOString(),
          fixtureId: m.id, homeTeam: t1, awayTeam: t2,
          leagueCode: game.slice(0, 5).toUpperCase(),
        });
      });
      results.push(r);
    }

    const created = results.filter(r => r?.success).length;
    const skipped = results.filter(r => r?.skipped).length;
    return { created, skipped };
  }
);

// ═══════════════════════════════════════════════════════════
// 2. MARKET LOCK CRON (every 5 min)
// ═══════════════════════════════════════════════════════════
export const marketLockCron = inngest.createFunction(
  { id: 'market-lock-cron', name: 'Market Lock Cron' },
  { cron: '*/5 * * * *' },
  async ({ step }) => {
    const supabaseAdmin = getSupabaseAdmin();
    const { data: markets } = await supabaseAdmin
      .from('markets').select('id, title')
      .eq('status', 'open').lt('closes_at', new Date().toISOString());
    if (!markets?.length) return { locked: 0 };
    const results = [];
    for (const m of markets) {
      const r = await step.run(`lock-${m.id}`, async () => {
        const res = await fetch(`${getBaseUrl()}/api/markets/lock`, {
          method: 'POST', headers: cronHeaders(),
          body: JSON.stringify({ marketId: m.id }),
        });
        const d = await res.json();
        return res.ok ? { marketId: m.id, success: true } : { marketId: m.id, success: false, error: d.error };
      });
      results.push(r);
    }
    return { locked: results.filter(r => r.success).length };
  }
);

// ═══════════════════════════════════════════════════════════
// 3. MULTI-SPORT ORACLE WORKER (every 5 min)
// ═══════════════════════════════════════════════════════════
export const oracleWorker = inngest.createFunction(
  { id: 'oracle-worker', name: 'Multi-Sport Oracle Worker' },
  { cron: '*/5 * * * *' },
  async ({ step }) => {
    const supabaseAdmin = getSupabaseAdmin();
    const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
    const { data: markets } = await supabaseAdmin
      .from('markets')
      .select('id, title, fixture_id, sport, options, resolution_attempts, closes_at')
      .eq('status', 'locked').eq('category', 'sports')
      .not('fixture_id', 'is', null).lt('closes_at', twoHoursAgo);
    if (!markets?.length) return { resolved: 0 };

    const results = [];
    for (const market of markets) {
      const r = await step.run(`oracle-${market.id}`, async () => {
        const attempts = market.resolution_attempts || 0;
        if (attempts > 576) {
          try {
            await supabaseAdmin.from('notifications').insert({
              user_id: null, type: 'admin_alert',
              message: `⚠️ Market ${market.id} (${market.title}) unresolved after 48h. Manual resolution required.`,
            });
          } catch(err) {}
          return { marketId: market.id, success: false, reason: 'max_attempts' };
        }
        await supabaseAdmin.from('markets').update({ resolution_attempts: attempts + 1 }).eq('id', market.id);

        const sport = market.sport || 'football';
        let winningOutcomeIndex: number | null = null;

        try {
          if (sport === 'football') {
            const key = process.env.FOOTBALL_DATA_API_KEY;
            if (!key) return { marketId: market.id, success: false, reason: 'no_key' };
            const res = await fetch(`https://api.football-data.org/v4/matches/${market.fixture_id}`, { headers: { 'X-Auth-Token': key } });
            if (!res.ok) return { marketId: market.id, success: false, reason: `api_${res.status}` };
            const d = await res.json();
            if (d.status !== 'FINISHED') return { marketId: market.id, success: false, reason: d.status };
            const map: Record<string, number> = { HOME_TEAM: 0, DRAW: 1, AWAY_TEAM: 2 };
            winningOutcomeIndex = map[d.score?.winner] ?? null;

          } else if (sport === 'basketball' || sport === 'tennis') {
            const key = process.env.API_SPORTS_KEY;
            if (!key) return { marketId: market.id, success: false, reason: 'no_api_sports_key' };
            const host = sport === 'basketball' ? 'api-basketball.p.rapidapi.com' : 'api-tennis.p.rapidapi.com';
            const url = sport === 'basketball'
              ? `https://${host}/games?id=${market.fixture_id}`
              : `https://${host}/matches/${market.fixture_id}`;
            const res = await fetch(url, { headers: { 'X-RapidAPI-Key': key, 'X-RapidAPI-Host': host } });
            if (!res.ok) return { marketId: market.id, success: false, reason: `api_sports_${res.status}` };
            const d = await res.json();
            const game = d.response?.[0];
            if (!game) return { marketId: market.id, success: false, reason: 'no_data' };
            const finished = ['FT', 'AOT', 'Finished'].includes(game.status?.short || game.status);
            if (!finished) return { marketId: market.id, success: false, reason: 'not_finished' };
            const homeScore = game.scores?.home?.total ?? 0;
            const awayScore = game.scores?.away?.total ?? 0;
            winningOutcomeIndex = homeScore > awayScore ? 0 : 1;

          } else if (sport === 'esports') {
            const key = process.env.PANDASCORE_API_KEY;
            if (!key) return { marketId: market.id, success: false, reason: 'no_pandascore_key' };
            const res = await fetch(`https://api.pandascore.co/matches/${market.fixture_id}`, { headers: { Authorization: `Bearer ${key}` } });
            if (!res.ok) return { marketId: market.id, success: false, reason: `pandascore_${res.status}` };
            const m = await res.json();
            if (m.status !== 'finished') return { marketId: market.id, success: false, reason: m.status };
            const winner = m.winner?.name;
            const opts = market.options as string[];
            const idx = opts.findIndex((o: string) => o.toLowerCase().includes((winner || '').toLowerCase()));
            winningOutcomeIndex = idx >= 0 ? idx : null;
          }
        } catch (e: any) {
          return { marketId: market.id, success: false, error: e.message };
        }

        if (winningOutcomeIndex === null) return { marketId: market.id, success: false, reason: 'no_winner' };

        const resolveRes = await fetch(`${getBaseUrl()}/api/markets/resolve`, {
          method: 'POST', headers: cronHeaders(),
          body: JSON.stringify({ marketId: market.id, winningOutcomeIndex }),
        });
        const resolveData = await resolveRes.json();
        if (!resolveRes.ok) return { marketId: market.id, success: false, error: resolveData.error };
        return { marketId: market.id, success: true, sport, outcome: winningOutcomeIndex };
      });
      results.push(r);
    }
    return { resolved: results.filter(r => r.success).length, checked: results.length };
  }
);

// ═══════════════════════════════════════════════════════════
// 4. WEEKLY HEARTBEAT (Sunday midnight UTC)
// ═══════════════════════════════════════════════════════════
export const weeklyHeartbeat = inngest.createFunction(
  { id: 'weekly-heartbeat', name: 'Weekly Escape Hatch Heartbeat' },
  { cron: '0 0 * * 0' },
  async ({ step }) => {
    await step.run('fire-heartbeat', async () => {
      const res = await fetch(`${getBaseUrl()}/api/admin/heartbeat`, {
        method: 'POST', headers: cronHeaders(),
      });
      const d = await res.json();
      if (!res.ok) throw new Error(`Heartbeat failed: ${d.error}`);
      return { success: true };
    });
  }
);

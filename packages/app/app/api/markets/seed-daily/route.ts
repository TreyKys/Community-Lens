import { NextResponse } from 'next/server';
import {
  FOOTBALL_LEAGUES,
  BASKETBALL_LEAGUES,
  fetchFootballFixtures,
  fetchApiSportsFixtures,
  fetchEsportsFixtures,
  createMarketIfNotExists,
  esportsGameCode,
} from '@/lib/oracle';

export const dynamic = 'force-dynamic';
export const maxDuration = 300;

type SourceStat = { fetched: number; created: number; skipped: number; errors: string[] };
const blank = (): SourceStat => ({ fetched: 0, created: 0, skipped: 0, errors: [] });

function bump(stat: SourceStat, r: { success?: boolean; skipped?: boolean; error?: string }) {
  if (r?.skipped) stat.skipped++;
  else if (r?.success) stat.created++;
  if (r?.error) stat.errors.push(r.error);
}

export async function POST(request: Request) {
  const cronSecret = request.headers.get('x-cron-secret');
  if (cronSecret !== process.env.CRON_SECRET) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const football: Record<string, SourceStat> = {};
  const basketball: Record<string, SourceStat> = {};
  const esports: SourceStat = blank();

  // Football
  for (const code of FOOTBALL_LEAGUES) {
    const stat = football[code] = blank();
    const fixtures = await fetchFootballFixtures(code);
    stat.fetched = fixtures.length;
    for (const match of fixtures.slice(0, 4)) {
      try {
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
        bump(stat, parent);
        if (!parent.success || parent.skipped || !parent.marketId) continue;

        const subs = [
          { q: `[${code}] ${home} vs ${away} (BTTS)`, opts: ['Yes - Both Score', 'No - Both Score'] },
          { q: `[${code}] ${home} vs ${away} (Over/Under 2.5)`, opts: ['Over 2.5 Goals', 'Under 2.5 Goals'] },
        ];
        for (const sub of subs) {
          const r = await createMarketIfNotExists({
            question: sub.q, category: 'sports', sport: 'football',
            options: sub.opts, closesAt: kickoff, fixtureId: match.id,
            homeTeam: home, awayTeam: away, leagueCode: code,
            parentMarketId: parent.marketId,
          });
          bump(stat, r);
        }
      } catch (err: any) {
        stat.errors.push(err?.message || 'unknown');
      }
    }
  }

  // Basketball
  for (const { code, apiSportsId } of BASKETBALL_LEAGUES) {
    const stat = basketball[code] = blank();
    const games = await fetchApiSportsFixtures('basketball', apiSportsId);
    stat.fetched = games.length;
    for (const g of games.slice(0, 10)) {
      try {
        const home = g.teams?.home?.name || 'Home';
        const away = g.teams?.away?.name || 'Away';
        const r = await createMarketIfNotExists({
          question: `[${code}] ${away} @ ${home} — Winner`,
          category: 'sports', sport: 'basketball',
          options: [`${home} Win`, `${away} Win`],
          closesAt: new Date(g.date).toISOString(),
          fixtureId: g.id, homeTeam: home, awayTeam: away, leagueCode: code,
        });
        bump(stat, r);
      } catch (err: any) {
        stat.errors.push(err?.message || 'unknown');
      }
    }
  }

  // eSports
  const es = await fetchEsportsFixtures();
  esports.fetched = es.length;
  for (const m of es.slice(0, 8)) {
    try {
      if (!m.opponents || m.opponents.length < 2) continue;
      const t1 = m.opponents[0]?.opponent?.name || 'Team 1';
      const t2 = m.opponents[1]?.opponent?.name || 'Team 2';
      const code = esportsGameCode(m.videogame?.slug, m.videogame?.name);
      const r = await createMarketIfNotExists({
        question: `[${code}] ${t1} vs ${t2} — Winner`,
        category: 'sports', sport: 'esports',
        options: [`${t1} Win`, `${t2} Win`],
        closesAt: new Date(m.begin_at || m.scheduled_at).toISOString(),
        fixtureId: m.id, homeTeam: t1, awayTeam: t2,
        leagueCode: code,
      });
      bump(esports, r);
    } catch (err: any) {
      esports.errors.push(err?.message || 'unknown');
    }
  }

  const sumStats = (stats: SourceStat[]) =>
    stats.reduce(
      (acc, s) => ({ created: acc.created + s.created, skipped: acc.skipped + s.skipped, fetched: acc.fetched + s.fetched }),
      { created: 0, skipped: 0, fetched: 0 }
    );
  const all = [...Object.values(football), ...Object.values(basketball), esports];
  const totals = sumStats(all);

  // Surface the missing-config case explicitly so it's obvious in the workflow log.
  const baseUrlMissing = !process.env.NEXT_PUBLIC_APP_URL;

  return NextResponse.json({
    totals: { ...totals, total: totals.created + totals.skipped },
    football,
    basketball,
    esports,
    config: {
      footballDataKeySet: !!process.env.FOOTBALL_DATA_API_KEY,
      apiSportsKeySet: !!process.env.API_SPORTS_KEY,
      pandascoreKeySet: !!process.env.PANDASCORE_API_KEY,
      appUrlSet: !baseUrlMissing,
    },
  });
}

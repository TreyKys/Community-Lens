import { NextResponse } from 'next/server';
import {
  FOOTBALL_LEAGUES,
  fetchFootballFixtures,
  fetchApiSportsFixtures,
  fetchEsportsFixtures,
  createMarketIfNotExists,
} from '@/lib/oracle';

export const dynamic = 'force-dynamic';
export const maxDuration = 300;

export async function POST(request: Request) {
  const cronSecret = request.headers.get('x-cron-secret');
  if (cronSecret !== process.env.CRON_SECRET) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const results: any[] = [];

  // Football
  for (const code of FOOTBALL_LEAGUES) {
    const fixtures = await fetchFootballFixtures(code);
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
        results.push(parent);
        if (!parent.success || parent.skipped || !parent.marketId) continue;

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
      } catch (err: any) {
        results.push({ success: false, error: err.message });
      }
    }
  }

  // Basketball (NBA)
  const nba = await fetchApiSportsFixtures('basketball', 12);
  for (const g of nba.slice(0, 10)) {
    try {
      const home = g.teams?.home?.name || 'Home';
      const away = g.teams?.away?.name || 'Away';
      const r = await createMarketIfNotExists({
        question: `[NBA] ${away} @ ${home} — Winner`,
        category: 'sports', sport: 'basketball',
        options: [`${home} Win`, `${away} Win`],
        closesAt: new Date(g.date).toISOString(),
        fixtureId: g.id, homeTeam: home, awayTeam: away, leagueCode: 'NBA',
      });
      results.push(r);
    } catch (err: any) {
      results.push({ success: false, error: err.message });
    }
  }

  // eSports
  const es = await fetchEsportsFixtures();
  for (const m of es.slice(0, 5)) {
    try {
      if (!m.opponents || m.opponents.length < 2) continue;
      const t1 = m.opponents[0]?.opponent?.name || 'Team 1';
      const t2 = m.opponents[1]?.opponent?.name || 'Team 2';
      const game = m.videogame?.name || 'eSports';
      const r = await createMarketIfNotExists({
        question: `[${game}] ${t1} vs ${t2} — Winner`,
        category: 'sports', sport: 'esports',
        options: [`${t1} Win`, `${t2} Win`],
        closesAt: new Date(m.begin_at || m.scheduled_at).toISOString(),
        fixtureId: m.id, homeTeam: t1, awayTeam: t2,
        leagueCode: (game as string).slice(0, 5).toUpperCase(),
      });
      results.push(r);
    } catch (err: any) {
      results.push({ success: false, error: err.message });
    }
  }

  const created = results.filter((r) => r?.success).length;
  const skipped = results.filter((r) => r?.skipped).length;

  return NextResponse.json({ created, skipped, total: results.length });
}

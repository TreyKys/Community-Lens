import { NextResponse } from 'next/server';
import { isAdminRequest } from '@/lib/adminAuth';

// Admin odds lookup against The Odds API (the-odds-api.com).
//
// Returns the next ~20 upcoming matches for a sport, with the head-to-
// head odds AVERAGED across all bookmakers the free tier returns. The
// average is the "consensus line" — closer to true probability than any
// single book's quote, which is what we want as a seeding anchor.
//
// Caching: in-memory map keyed by (sport, regions). The free tier is
// 500 requests/month — without caching one admin can burn that in an
// afternoon. We cache aggressively (60 min TTL) since odds drift slowly
// pre-event.
//
// Env: THE_ODDS_API_KEY (Netlify-side env var, never exposed to the
// browser).

const ENDPOINT = 'https://api.the-odds-api.com/v4/sports';
const CACHE_TTL_MS = 60 * 60 * 1000; // 60 min
const cache = new Map<string, { at: number; payload: any }>();

interface UpstreamEvent {
  id: string;
  sport_key: string;
  commence_time: string;
  home_team: string;
  away_team: string;
  bookmakers: Array<{
    key: string;
    title: string;
    markets: Array<{
      key: string;
      outcomes: Array<{ name: string; price: number }>;
    }>;
  }>;
}

// Normalised consensus per outcome.
interface ConsensusOutcome {
  name: string;
  avgOdds: number;
  bookmakerCount: number;
  spread: { min: number; max: number };
}

interface NormalisedEvent {
  id: string;
  homeTeam: string;
  awayTeam: string;
  commenceAt: string;
  outcomes: ConsensusOutcome[]; // ordered: home, draw (3-way only), away
}

function consensusFromBookmakers(ev: UpstreamEvent): ConsensusOutcome[] {
  // Pull every bookmaker's h2h outcomes into per-name buckets.
  const buckets: Record<string, number[]> = {};
  for (const bm of ev.bookmakers || []) {
    const h2h = (bm.markets || []).find(m => m.key === 'h2h');
    if (!h2h) continue;
    for (const o of h2h.outcomes || []) {
      if (!Number.isFinite(o.price) || o.price <= 1) continue;
      (buckets[o.name] ||= []).push(o.price);
    }
  }

  // Average each, sort canonical: home, draw, away (so the UI maps
  // 1-to-1 with a 1X2 market).
  const namesInOrder: string[] = [];
  if (buckets[ev.home_team]) namesInOrder.push(ev.home_team);
  if (buckets['Draw']) namesInOrder.push('Draw');
  if (buckets[ev.away_team]) namesInOrder.push(ev.away_team);
  // Add any leftover bucket names (shouldn't happen for h2h but defensive).
  for (const n of Object.keys(buckets)) {
    if (!namesInOrder.includes(n)) namesInOrder.push(n);
  }

  return namesInOrder.map(name => {
    const vals = buckets[name];
    const sum = vals.reduce((a, b) => a + b, 0);
    return {
      name,
      avgOdds: Math.round((sum / vals.length) * 100) / 100,
      bookmakerCount: vals.length,
      spread: { min: Math.min(...vals), max: Math.max(...vals) },
    };
  });
}

async function fetchOdds(sport: string, regions: string): Promise<UpstreamEvent[]> {
  const key = process.env.THE_ODDS_API_KEY;
  if (!key) throw new Error('THE_ODDS_API_KEY env var not set');

  const cacheKey = `${sport}|${regions}`;
  const hit = cache.get(cacheKey);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.payload;

  const url = `${ENDPOINT}/${encodeURIComponent(sport)}/odds?apiKey=${key}&regions=${regions}&markets=h2h&oddsFormat=decimal`;
  const res = await fetch(url, { headers: { Accept: 'application/json' } });

  if (res.status === 401) throw new Error('The Odds API rejected the key (401). Check THE_ODDS_API_KEY.');
  if (res.status === 429) throw new Error('The Odds API rate-limited us. Try again in a few minutes.');
  if (!res.ok) throw new Error(`The Odds API returned ${res.status}`);

  const data: UpstreamEvent[] = await res.json();
  cache.set(cacheKey, { at: Date.now(), payload: data });
  // Bound the cache to avoid runaway growth if we ever expand sport list.
  if (cache.size > 50) {
    const oldest = Array.from(cache.entries()).sort((a, b) => a[1].at - b[1].at)[0];
    if (oldest) cache.delete(oldest[0]);
  }
  return data;
}

// GET /api/admin/lookup-odds?sport=soccer_epl&q=arsenal&regions=eu,uk
export async function GET(request: Request) {
  if (!isAdminRequest(request)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  if (!process.env.THE_ODDS_API_KEY) {
    return NextResponse.json({
      error: 'THE_ODDS_API_KEY is not configured. Add the env var on Netlify and redeploy.',
      configured: false,
    }, { status: 503 });
  }

  try {
    const { searchParams } = new URL(request.url);
    const sport = (searchParams.get('sport') || 'soccer_epl').trim();
    const q = (searchParams.get('q') || '').trim().toLowerCase();
    const regions = (searchParams.get('regions') || 'eu,uk').trim();

    const raw = await fetchOdds(sport, regions);

    // Filter by team-name query and normalise. Empty query returns
    // everything (capped at 20 most-imminent fixtures).
    const filtered = raw.filter(ev => {
      if (!q) return true;
      return ev.home_team.toLowerCase().includes(q)
        || ev.away_team.toLowerCase().includes(q);
    });

    const events: NormalisedEvent[] = filtered
      .map(ev => ({
        id: ev.id,
        homeTeam: ev.home_team,
        awayTeam: ev.away_team,
        commenceAt: ev.commence_time,
        outcomes: consensusFromBookmakers(ev),
      }))
      .filter(e => e.outcomes.length >= 2)
      .sort((a, b) => new Date(a.commenceAt).getTime() - new Date(b.commenceAt).getTime())
      .slice(0, 20);

    return NextResponse.json({
      configured: true,
      sport,
      query: q,
      count: events.length,
      events,
    });
  } catch (e: any) {
    console.error('lookup-odds error:', e);
    return NextResponse.json({ error: e?.message || 'Internal error' }, { status: 500 });
  }
}

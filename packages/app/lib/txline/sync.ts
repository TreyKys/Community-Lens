// Turn TxLINE World Cup fixtures into Opinions "Match Winner" markets.
//
// Markets are written directly (not through /api/admin/market) so we can set
// the TxLINE mapping columns. We dedupe on txline_fixture_id and deliberately
// leave fixture_id NULL, which makes lookupMarketResult skip the football-data
// path — TxLINE owns resolution for these markets.

import { getSupabaseAdmin } from '@/lib/oracle';
import { listFixtures, epochDay, type TxLineFixture } from './client';
import { txlineConfig } from './config';

// The fixtures endpoint filters to fixtures on/after startEpochDay. Left
// unset, an empty/omitted value appears to default to "today" server-side —
// which returns nothing once the tournament has finished. We always pass an
// explicit day well before kickoff so a sync run gets the full competition
// regardless of when it's run relative to the tournament.
const WORLD_CUP_START_EPOCH_DAY = epochDay(new Date('2026-06-01T00:00:00Z').getTime());

export type SyncResult = {
  fetched: number;
  created: number;
  skipped: number;
  errors: string[];
};

/** Build the 1X2 option list for a fixture: [home, Draw, away]. */
export function fixtureOptions(f: TxLineFixture): string[] {
  return [f.Participant1, 'Draw', f.Participant2];
}

export function fixtureQuestion(f: TxLineFixture): string {
  return `${f.Participant1} vs ${f.Participant2} — Match Winner`;
}

/**
 * Upsert one market for a fixture. Returns 'created' | 'skipped' (already
 * mapped) — never throws for the dedupe race; caller collects errors.
 */
async function upsertFixtureMarket(f: TxLineFixture): Promise<'created' | 'skipped'> {
  const supabaseAdmin = getSupabaseAdmin();

  const { data: existing } = await supabaseAdmin
    .from('markets')
    .select('id')
    .eq('txline_fixture_id', f.FixtureId)
    .maybeSingle();
  if (existing) return 'skipped';

  const closesAt = new Date(f.StartTime).toISOString();
  const question = fixtureQuestion(f);

  const { error } = await supabaseAdmin.from('markets').insert({
    title: question.slice(0, 80),
    question,
    category: 'sports',
    sport: 'football',
    options: fixtureOptions(f),
    closes_at: closesAt,
    status: 'open',
    // Leave fixture_id NULL so the legacy football-data lookup is skipped;
    // TxLINE settles these via the proof path.
    fixture_id: null,
    home_team: f.Participant1,
    away_team: f.Participant2,
    league_code: 'WC',
    txline_fixture_id: f.FixtureId,
    txline_competition_id: f.CompetitionId,
  });

  if (error) {
    // Unique-ish races: if another run inserted it first, treat as skipped.
    if (/duplicate|unique/i.test(error.message)) return 'skipped';
    throw new Error(`fixture ${f.FixtureId}: ${error.message}`);
  }
  return 'created';
}

/**
 * Sync all covered World Cup fixtures into markets.
 * @param limit optional cap (newest-first by kickoff) to avoid flooding.
 */
export async function syncWorldCupFixtures(limit?: number): Promise<SyncResult> {
  const result: SyncResult = { fetched: 0, created: 0, skipped: 0, errors: [] };

  const fixtures = await listFixtures(txlineConfig.competitionId, WORLD_CUP_START_EPOCH_DAY);
  result.fetched = fixtures.length;

  // Sort by kickoff ascending so a limited run keeps the soonest fixtures.
  const ordered = [...fixtures].sort((a, b) => a.StartTime - b.StartTime);
  const slice = typeof limit === 'number' ? ordered.slice(0, limit) : ordered;

  for (const f of slice) {
    try {
      const outcome = await upsertFixtureMarket(f);
      if (outcome === 'created') result.created++;
      else result.skipped++;
    } catch (err: any) {
      result.errors.push(err?.message || String(err));
    }
  }

  return result;
}

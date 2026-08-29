import { describe, it, expect } from 'vitest';
import { FOOTBALL_LEAGUES, selectSeedableFixtures } from './oracle';

// The board is deliberately three competitions, and La Liga is deliberately
// only its big three. These are the two rules that keep the house off markets
// nobody here trades, so they are worth pinning.

// football-data.org fixture shape, trimmed to what the filter reads.
const fixture = (home: Partial<any>, away: Partial<any>) => ({
  homeTeam: home,
  awayTeam: away,
});

describe('FOOTBALL_LEAGUES', () => {
  it('is exactly EPL, Champions League and La Liga', () => {
    expect([...FOOTBALL_LEAGUES].sort()).toEqual(['CL', 'PD', 'PL']);
  });

  it('carries none of the scrapped leagues', () => {
    for (const gone of ['SA', 'BL1', 'FL1', 'DED', 'PPL', 'BSA', 'EC', 'WC', 'ELC']) {
      expect(FOOTBALL_LEAGUES).not.toContain(gone);
    }
  });
});

describe('selectSeedableFixtures — PL and CL pass through', () => {
  const games = [
    fixture({ id: 57, name: 'Arsenal' }, { id: 65, name: 'Man City' }),
    fixture({ id: 66, name: 'Man United' }, { id: 61, name: 'Chelsea' }),
  ];
  it('keeps every Premier League fixture', () => {
    expect(selectSeedableFixtures('PL', games)).toHaveLength(2);
  });
  it('keeps every Champions League fixture', () => {
    expect(selectSeedableFixtures('CL', games)).toHaveLength(2);
  });
});

describe('selectSeedableFixtures — La Liga is narrowed to the big three', () => {
  it('keeps a fixture with Real Madrid (by id)', () => {
    const out = selectSeedableFixtures('PD', [
      fixture({ id: 86, name: 'Real Madrid CF' }, { id: 90, name: 'Real Betis' }),
    ]);
    expect(out).toHaveLength(1);
  });

  it('keeps El Clásico', () => {
    const out = selectSeedableFixtures('PD', [
      fixture({ id: 86, name: 'Real Madrid CF' }, { id: 81, name: 'FC Barcelona' }),
    ]);
    expect(out).toHaveLength(1);
  });

  it('drops a mid-table fixture with none of the three', () => {
    const out = selectSeedableFixtures('PD', [
      fixture({ id: 82, name: 'Getafe CF' }, { id: 558, name: 'RC Celta' }),
    ]);
    expect(out).toHaveLength(0);
  });

  it('filters a mixed slate down to only the big-three games', () => {
    const out = selectSeedableFixtures('PD', [
      fixture({ id: 78, name: 'Atlético Madrid' }, { id: 82, name: 'Getafe CF' }), // keep
      fixture({ id: 79, name: 'CA Osasuna' }, { id: 92, name: 'Real Sociedad' }),  // drop
      fixture({ id: 81, name: 'FC Barcelona' }, { id: 95, name: 'Valencia CF' }),  // keep
    ]);
    expect(out).toHaveLength(2);
  });

  it('catches the big three by NAME when the id is missing or wrong', () => {
    // A provider hiccup that drops or changes the id must not silently seed
    // nothing — the name fallback is the safety net.
    const out = selectSeedableFixtures('PD', [
      fixture({ name: 'Real Madrid' }, { name: 'Villarreal CF' }),
      fixture({ id: 99999, name: 'FC Barcelona' }, { name: 'Sevilla FC' }),
      fixture({ name: 'Atlético de Madrid' }, { name: 'Elche CF' }),
    ]);
    expect(out).toHaveLength(3);
  });

  it('does not mistake a non-Madrid Real for a big club', () => {
    // "Real Sociedad" and "Real Betis" contain "real" but are not the big
    // three; the name tokens are the full club names, not the word "real".
    const out = selectSeedableFixtures('PD', [
      fixture({ id: 92, name: 'Real Sociedad' }, { id: 90, name: 'Real Betis' }),
    ]);
    expect(out).toHaveLength(0);
  });

  it('survives a fixture with missing team objects', () => {
    const out = selectSeedableFixtures('PD', [
      fixture({}, {}),
      fixture({ name: 'Barcelona' }, {}),
    ]);
    expect(out).toHaveLength(1);
  });
});

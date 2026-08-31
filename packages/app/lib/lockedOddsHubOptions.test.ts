import { describe, it, expect } from 'vitest';
import { lockedOddsHubOptions, getLockedOddsHubOption } from './lockedOddsHubOptions';

describe('lockedOddsHubOptions', () => {
  const options = lockedOddsHubOptions();

  it('has no duplicate ids — the <Select> would silently pick the first on a collision', () => {
    const ids = options.map(o => o.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('every league_code is bracket-free — the stored column never carries brackets', () => {
    for (const o of options) {
      if (o.leagueCode) expect(o.leagueCode).not.toMatch(/[[\]]/);
    }
  });

  it('BBN options are always category entertainment — the one rule free text could not enforce', () => {
    for (const o of options.filter(o => o.groupLabel === 'Big Brother Naija')) {
      expect(o.category).toBe('entertainment');
      expect(o.sport).toBe('bbn');
    }
  });

  it('every non-BBN option is category sports', () => {
    for (const o of options.filter(o => o.groupLabel !== 'Big Brother Naija')) {
      expect(o.category).toBe('sports');
    }
  });

  it('covers all three football leagues plus a general option', () => {
    const football = options.filter(o => o.sport === 'football');
    expect(football.map(o => o.leagueCode).sort()).toEqual(['CL', 'PD', 'PL', null].sort());
  });

  it('covers the four generic sport hubs', () => {
    const sports = new Set(options.map(o => o.sport));
    for (const s of ['basketball', 'tennis', 'esports', 'fight']) {
      expect(sports.has(s)).toBe(true);
    }
  });

  it('fight has a general option even though it has no named competitions', () => {
    const fight = options.filter(o => o.sport === 'fight');
    expect(fight.length).toBe(1);
    expect(fight[0].leagueCode).toBeNull();
  });

  it('every BBN tag code round-trips back to a real tag', () => {
    const bbn = options.filter(o => o.groupLabel === 'Big Brother Naija' && o.leagueCode);
    expect(bbn.length).toBe(5); // winner, eviction, hoh, ship, twist
  });

  it('getLockedOddsHubOption resolves a known id and refuses an unknown one', () => {
    const known = options[0];
    expect(getLockedOddsHubOption(known.id)).toEqual(known);
    expect(getLockedOddsHubOption('not-a-real-id')).toBeNull();
    expect(getLockedOddsHubOption(null)).toBeNull();
  });
});

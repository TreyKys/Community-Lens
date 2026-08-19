// Big Brother Naija market-type tags.
//
// BBN is one show, not a family of leagues, so it doesn't need football's
// league-tab pattern. What it DOES need is a way to separate "who wins the
// season" from "who's evicted this week" from "who's shipped with who" —
// those are different kinds of bets a viewer comes back for at different
// points in the week.
//
// Reuses the exact mechanism /football uses for league tabs (the
// league_code column + MarketList's leagueCode prop, scoped to
// category='entertainment' via scopeCategory) rather than inventing a new
// filter path. An admin tags a market with one of these codes the same way
// they'd tag a football market [PL] — by setting the market's league_code.

export type BbnTag = {
  id: string;
  code: string;       // matches markets.league_code exactly (no brackets)
  label: string;
  shortLabel: string;
  blurb: string;
};

export const BBN_SPORT = 'bbn';

export const BBN_TAGS: Record<string, BbnTag> = {
  winner: {
    id: 'winner',
    code: 'BBN_WINNER',
    label: 'Season Winner',
    shortLabel: 'Winner',
    blurb: 'Who lifts the trophy.',
  },
  eviction: {
    id: 'eviction',
    code: 'BBN_EVICTION',
    label: 'Eviction Watch',
    shortLabel: 'Eviction',
    blurb: 'Who’s leaving the house this week.',
  },
  hoh: {
    id: 'hoh',
    code: 'BBN_HOH',
    label: 'Head of House',
    shortLabel: 'HOH',
    blurb: 'This week’s power player.',
  },
  ship: {
    id: 'ship',
    code: 'BBN_SHIP',
    label: 'Ships',
    shortLabel: 'Ships',
    blurb: 'Who’s coupling up.',
  },
  twist: {
    id: 'twist',
    code: 'BBN_TWIST',
    label: 'Twists & Tasks',
    shortLabel: 'Twists',
    blurb: 'Wildcard house drama.',
  },
};

export const BBN_TAG_IDS = Object.keys(BBN_TAGS);

export function getBbnTag(id: string | null | undefined): BbnTag | null {
  if (!id) return null;
  return BBN_TAGS[id] ?? null;
}

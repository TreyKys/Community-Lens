export type League = {
  id: string;
  code: string;
  label: string;
  shortLabel: string;
  logoUrl: string;
  accent: string;
  tagline: string;
};

// THREE LEAGUES, matching FOOTBALL_LEAGUES in lib/oracle.ts.
//
// The board used to carry twelve — Serie A, Bundesliga, Ligue 1, Eredivisie,
// the Brazilian league, the Championship, and the rest. Each one is a market
// the house prices and stands behind, and most drew almost no volume from a
// Nigerian audience that follows the Premier League, La Liga's big clubs, and
// the Champions League. The other nine were scrapped at source (seeding) and
// here (the hub), so no league tile leads to a page that never fills.
//
// These two lists MUST agree: a code here with no counterpart in
// FOOTBALL_LEAGUES is a hub tile for a league that never seeds a fixture.
export const LEAGUES: Record<string, League> = {
  pl: {
    id: 'pl',
    code: '[PL]',
    label: 'Premier League',
    shortLabel: 'EPL',
    logoUrl: 'https://play-lh.googleusercontent.com/gvlKi4GfJUgLh6HaVbM1wz_55NVngbs1Icn4t9oDzXIyxSLiT3401TrjAJNpeJs7mKtg1Tm2yTDFv_-mkWxh',
    accent: '#37003c',
    tagline: 'The world’s most-watched league.',
  },
  pd: {
    id: 'pd',
    code: '[PD]',
    label: 'LaLiga',
    shortLabel: 'LaLiga',
    logoUrl: 'https://encrypted-tbn0.gstatic.com/images?q=tbn:ANd9GcRUGbQamPAx5pFfixle596BNKgC--U5GbodfQ&s',
    accent: '#ee8707',
    // The board only carries the big clubs' fixtures, and the tagline should
    // not promise more than that.
    tagline: 'Madrid, Barça, Atléti — the games that matter.',
  },
  cl: {
    id: 'cl',
    code: '[CL]',
    label: 'Champions League',
    shortLabel: 'UCL',
    logoUrl: 'https://ktsportdesign.com/articles/the-evolution-of-the-champions-league-logo/ktsport-article-home.webp',
    accent: '#00326e',
    tagline: 'Europe’s biggest nights.',
  },
};

export const LEAGUE_IDS = Object.keys(LEAGUES);

export function getLeague(id: string | null | undefined): League | null {
  if (!id) return null;
  return LEAGUES[id] ?? null;
}

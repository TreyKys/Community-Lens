export type League = {
  id: string;
  code: string;
  label: string;
  shortLabel: string;
  logoUrl: string;
  accent: string;
  tagline: string;
};

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
    tagline: 'Spain’s top flight.',
  },
  sa: {
    id: 'sa',
    code: '[SA]',
    label: 'Serie A',
    shortLabel: 'Serie A',
    logoUrl: 'https://encrypted-tbn0.gstatic.com/images?q=tbn:ANd9GcSRgnsfLeiWXmP3qc5iQ-YGYlvLm0_jX7MW2Q&s',
    accent: '#008fd7',
    tagline: 'Italy’s tactical masterclass.',
  },
  bl1: {
    id: 'bl1',
    code: '[BL1]',
    label: 'Bundesliga',
    shortLabel: 'Bundesliga',
    logoUrl: 'https://assets.bundesliga.com/logos/bundesliga.jpg?fit=512,512',
    accent: '#d20515',
    tagline: 'Germany’s goal machine.',
  },
  fl1: {
    id: 'fl1',
    code: '[FL1]',
    label: 'Ligue 1',
    shortLabel: 'Ligue 1',
    logoUrl: 'https://1000logos.net/wp-content/uploads/2019/01/French-Ligue-1-Logo-2020-1.png',
    accent: '#091c3e',
    tagline: 'France’s flair on display.',
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
  ded: {
    id: 'ded',
    code: '[DED]',
    label: 'Eredivisie',
    shortLabel: 'Eredivisie',
    logoUrl: 'https://sassets.knvb.nl/sites/knvb.com/files/styles/ls-1920x1080/public/eredivisie.jpg?itok=mss_gX9N',
    accent: '#e31c23',
    tagline: 'The Dutch proving ground.',
  },
  bsa: {
    id: 'bsa',
    code: '[BSA]',
    label: 'Brasileirão',
    shortLabel: 'Brasileirão',
    logoUrl: 'https://1000marcas.net/wp-content/uploads/2020/03/Campeonato-Brasileiro-S%C3%A9rie-A-logo.png',
    accent: '#009c3b',
    tagline: 'Brazil’s top flight samba.',
  },
  ppl: {
    id: 'ppl',
    code: '[PPL]',
    label: 'Primeira Liga',
    shortLabel: 'Primeira Liga',
    logoUrl: 'https://1000logos.net/wp-content/uploads/2022/01/Portuguese-Primeira-Liga-logo.jpg',
    accent: '#006633',
    tagline: 'Portugal’s top-tier drama.',
  },
  wc: {
    id: 'wc',
    code: '[WC]',
    label: 'World Cup',
    shortLabel: 'World Cup',
    logoUrl: 'https://upload.wikimedia.org/wikipedia/en/thumb/e/e8/2026_FIFA_World_Cup_emblem.svg/1024px-2026_FIFA_World_Cup_emblem.svg.png',
    accent: '#0a2240',
    tagline: 'The world stops to watch.',
  },
  ec: {
    id: 'ec',
    code: '[EC]',
    label: 'Euros',
    shortLabel: 'Euros',
    logoUrl: 'https://upload.wikimedia.org/wikipedia/en/thumb/0/04/UEFA_Euro_2024_Logo.svg/1024px-UEFA_Euro_2024_Logo.svg.png',
    accent: '#003399',
    tagline: 'Europe’s grand stage.',
  },
  elc: {
    id: 'elc',
    code: '[ELC]',
    label: 'Championship',
    shortLabel: 'EFL',
    logoUrl: 'https://upload.wikimedia.org/wikipedia/en/thumb/5/5d/EFL_Championship.svg/1024px-EFL_Championship.svg.png',
    accent: '#172983',
    tagline: 'The road to the Premier League.',
  },
};

export const LEAGUE_IDS = Object.keys(LEAGUES);

export function getLeague(id: string | null | undefined): League | null {
  if (!id) return null;
  return LEAGUES[id] ?? null;
}

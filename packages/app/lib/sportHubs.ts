// Sport hub configuration.
//
// One entry per dedicated hub page (/basketball, /tennis, /esports, /fight).
// Adding another sport is an entry here plus a three-line page file — the hub
// component, the filtering, the backdrop and the nav all read from this.
//
// IMAGERY — read before setting `imageUrl`:
//
// Every hub ships with hand-built CSS gradient art (`gradient`) that renders
// instantly, costs no network request, and can never 404. `imageUrl` is
// OPTIONAL and overlays a photo on top of that art when set, so a missing or
// slow image degrades to something that still looks finished rather than to a
// blank rectangle.
//
// When supplying a photo:
//   * Use one you have the RIGHT to use. A hotlinked search result can vanish
//     or draw a takedown, and this is a real-money site — it is not the place
//     to be casual about licensing.
//   * Wide landscape, 2400px+ on the long edge. It renders as a full-bleed
//     backdrop that fades out on scroll, so anything portrait or small will
//     look cropped and soft.
//   * Prefer a self-hosted file (/public) or your own CDN over a third-party
//     URL, so the page does not depend on someone else's uptime.
//
// Files live in public/hubs/ — see the README there for the expected names
// and why they are served without re-encoding.

export type SportHub = {
  id: string;             // route slug, e.g. 'basketball' -> /basketball
  sport: string;          // matches markets.sport
  label: string;
  tagline: string;
  /** Tailwind text colour for the accent icon + active chips. */
  accentClass: string;
  /** Two rgba stops used by the CSS backdrop art. */
  gradient: [string, string];
  /** Optional licensed photo. See the note above before setting one. */
  imageUrl?: string;
  /** Competition filters, matched against markets.league_code. Optional —
      a hub with none simply shows every market for its sport. */
  competitions?: Array<{ id: string; code: string; label: string }>;
  /** Excludes combat sports from the general ball hubs, mirroring
      buildCategoryFilter's `ball` behaviour. */
  excludeSport?: string;
};

export const SPORT_HUBS: Record<string, SportHub> = {
  basketball: {
    id: 'basketball',
    sport: 'basketball',
    label: 'Basketball',
    tagline: 'NBA nights and everything after the buzzer.',
    accentClass: 'text-orange-400',
    gradient: ['rgba(249,115,22,0.30)', 'rgba(120,53,15,0.22)'],
    imageUrl: '/hubs/basketball.webp',
    competitions: [
      { id: 'nba', code: 'NBA', label: 'NBA' },
      { id: 'euroleague', code: 'EUROLEAGUE', label: 'EuroLeague' },
    ],
  },
  tennis: {
    id: 'tennis',
    sport: 'tennis',
    label: 'Tennis',
    tagline: 'Every slam, every upset, point by point.',
    accentClass: 'text-lime-400',
    gradient: ['rgba(132,204,22,0.28)', 'rgba(21,94,60,0.22)'],
    imageUrl: '/hubs/tennis.webp',
    competitions: [
      { id: 'ao', code: 'AO', label: 'Australian Open' },
      { id: 'rg', code: 'RG', label: 'Roland Garros' },
      { id: 'wim', code: 'WIM', label: 'Wimbledon' },
      { id: 'uso', code: 'USO', label: 'US Open' },
    ],
  },
  esports: {
    id: 'esports',
    sport: 'esports',
    label: 'Esports',
    tagline: 'Majors, splits and grand finals.',
    accentClass: 'text-violet-400',
    gradient: ['rgba(139,92,246,0.30)', 'rgba(30,27,75,0.30)'],
    imageUrl: '/hubs/esports.webp',
    competitions: [
      { id: 'lol', code: 'LOL', label: 'League of Legends' },
      { id: 'csgo', code: 'CSGO', label: 'CS2' },
      { id: 'dota2', code: 'DOTA2', label: 'Dota 2' },
      { id: 'valorant', code: 'VAL', label: 'Valorant' },
      { id: 'r6s', code: 'R6S', label: 'Rainbow Six' },
    ],
  },
  fight: {
    id: 'fight',
    // 'fight' is the existing sport value for boxing/MMA/UFC — the markets
    // already exist under it and had only a category filter, never a hub.
    sport: 'fight',
    label: 'Boxing & MMA',
    tagline: 'Fight week, decided.',
    accentClass: 'text-red-400',
    gradient: ['rgba(239,68,68,0.28)', 'rgba(69,10,10,0.30)'],
    imageUrl: '/hubs/fight.webp',
  },
};

export const SPORT_HUB_IDS = Object.keys(SPORT_HUBS);

// Football keeps its own component (twelve leagues with logos, per-league
// landing pages — things the generic hub does not model), so it is not a
// SPORT_HUBS entry. Its backdrop art still lives here so all six hubs are
// configured in one place rather than one of them being special-cased in a
// component file.
export const FOOTBALL_HUB_ART: { gradient: [string, string]; imageUrl?: string } = {
  gradient: ['rgba(27,202,121,0.26)', 'rgba(6,78,59,0.26)'],
  imageUrl: '/hubs/football.webp',
};

export function getSportHub(id: string | null | undefined): SportHub | null {
  if (!id) return null;
  return SPORT_HUBS[id] ?? null;
}

// OPx Picks share-card themes.
//
// Each theme is a self-contained palette the OG image route + the
// landing page both read from. We expose six themes — three are the
// "expected" brand looks (emerald, violet, sunset) and three are
// experimental moods (midnight ice, cherry, money) so users have real
// choice. No theme is mandated as the default; the share modal picks
// the user's last choice from localStorage and falls back to emerald.
//
// The transparent O/N branding sits in the bottom corner of every
// theme — same opacity, same position — so the brand stays consistent
// across whichever palette the user picked.

export type PicksThemeId =
  | 'emerald'
  | 'violet'
  | 'sunset'
  | 'midnight'
  | 'cherry'
  | 'money';

export interface PicksTheme {
  id: PicksThemeId;
  label: string;
  /** The dominant accent — used for big numbers, badges, accent strokes. */
  accent: string;
  /** Lighter accent variant for sub-labels. */
  accentSoft: string;
  /** Optional secondary accent for sub-headers. */
  accentDim: string;
  /** Background gradient stops as an array of CSS color strings. */
  gradient: [string, string, string];
  /** Big glow blob colour (rgba). */
  glow: string;
  /** Foreground text colour on the gradient. */
  fg: string;
  /** Muted foreground colour (for "Predict and Win" etc.). */
  fgMuted: string;
  /** Body text colour. */
  fgBody: string;
  /** CTA button background. */
  ctaBg: string;
  /** CTA button text colour. */
  ctaFg: string;
}

export const PICKS_THEMES: Record<PicksThemeId, PicksTheme> = {
  emerald: {
    id: 'emerald',
    label: 'Emerald (default)',
    accent: '#34d399',
    accentSoft: '#a7f3d0',
    accentDim: '#10b981',
    gradient: ['#050A08', '#07231A', '#0A3A2C'],
    glow: 'rgba(52,211,153,0.30)',
    fg: '#ffffff',
    fgMuted: '#94a3b8',
    fgBody: '#cbd5e1',
    ctaBg: '#10b981',
    ctaFg: '#050A08',
  },
  violet: {
    id: 'violet',
    label: 'Violet',
    accent: '#a78bfa',
    accentSoft: '#ddd6fe',
    accentDim: '#8b5cf6',
    gradient: ['#0a0716', '#1c0e3a', '#2a1259'],
    glow: 'rgba(167,139,250,0.32)',
    fg: '#ffffff',
    fgMuted: '#a8a4c8',
    fgBody: '#d1cce9',
    ctaBg: '#8b5cf6',
    ctaFg: '#0a0716',
  },
  sunset: {
    id: 'sunset',
    label: 'Sunset',
    accent: '#fb923c',
    accentSoft: '#fed7aa',
    accentDim: '#f97316',
    gradient: ['#140707', '#3a0f17', '#5a1a1f'],
    glow: 'rgba(251,146,60,0.30)',
    fg: '#fff7ed',
    fgMuted: '#c9a89a',
    fgBody: '#f4d6c4',
    ctaBg: '#fb923c',
    ctaFg: '#140707',
  },
  midnight: {
    id: 'midnight',
    label: 'Midnight',
    accent: '#60a5fa',
    accentSoft: '#bfdbfe',
    accentDim: '#3b82f6',
    gradient: ['#020617', '#0f172a', '#1e293b'],
    glow: 'rgba(96,165,250,0.28)',
    fg: '#f8fafc',
    fgMuted: '#94a3b8',
    fgBody: '#cbd5e1',
    ctaBg: '#3b82f6',
    ctaFg: '#020617',
  },
  cherry: {
    id: 'cherry',
    label: 'Cherry',
    accent: '#fb7185',
    accentSoft: '#fecdd3',
    accentDim: '#f43f5e',
    gradient: ['#160409', '#3d0b1e', '#5a1330'],
    glow: 'rgba(251,113,133,0.32)',
    fg: '#fff1f2',
    fgMuted: '#c98ea3',
    fgBody: '#f7d0d8',
    ctaBg: '#f43f5e',
    ctaFg: '#160409',
  },
  money: {
    id: 'money',
    label: 'Money',
    accent: '#fbbf24',
    accentSoft: '#fde68a',
    accentDim: '#f59e0b',
    gradient: ['#0a0904', '#1f1808', '#3a2a0c'],
    glow: 'rgba(251,191,36,0.30)',
    fg: '#fffbeb',
    fgMuted: '#a8a085',
    fgBody: '#e8dcb3',
    ctaBg: '#fbbf24',
    ctaFg: '#0a0904',
  },
};

export const DEFAULT_PICKS_THEME: PicksThemeId = 'emerald';

export function resolveTheme(id: string | null | undefined): PicksTheme {
  if (!id) return PICKS_THEMES[DEFAULT_PICKS_THEME];
  const key = id.toLowerCase() as PicksThemeId;
  return PICKS_THEMES[key] ?? PICKS_THEMES[DEFAULT_PICKS_THEME];
}

export const PICKS_THEME_LIST: PicksTheme[] = [
  PICKS_THEMES.emerald,
  PICKS_THEMES.violet,
  PICKS_THEMES.sunset,
  PICKS_THEMES.midnight,
  PICKS_THEMES.cherry,
  PICKS_THEMES.money,
];

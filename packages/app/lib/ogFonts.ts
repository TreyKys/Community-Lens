// Shared font loader for every next/og ImageResponse route (the OPx Picks
// card, referral card, profile accuracy card).
//
// Satori (the renderer behind ImageResponse) does NOT use system fonts —
// it only draws glyphs present in whatever font buffer you explicitly
// pass via the `fonts` option, falling back to its own bundled font
// (near-ASCII coverage) for anything else, rendered as a "tofu" box for
// missing glyphs. Every card in this app was hitting that fallback for
// EVERY naira amount: Google's default "latin" font subset (what you get
// fetching a Google Fonts URL with no unicode-range) explicitly excludes
// ₦ (U+20A6 NAIRA SIGN) — only the "latin-ext" subset carries it. Verified
// against the actual font's cmap table before wiring this in, not assumed.
//
// Fetched once per lambda instance and cached in module scope — these
// routes are hit on every unfurl/share, so re-fetching the font on every
// request would be wasteful.

type OgFont = { name: string; data: ArrayBuffer; weight: 400 | 700; style: 'normal' };

// Google serves this exact file for both the 400 and 700 @font-face
// declarations in the latin-ext subset — it's a variable font (wght
// axis 100–900) under the hood, so one fetch covers every weight these
// cards use.
const NOTO_SANS_LATIN_EXT =
  'https://fonts.gstatic.com/s/notosans/v42/o-0bIpQlx3QUlC5A4PNB6Ryti20_6n1iPHjc5aDdu2ui.woff2';

let cached: OgFont[] | null = null;

export async function loadOgFonts(): Promise<OgFont[]> {
  if (cached) return cached;
  const data = await fetch(NOTO_SANS_LATIN_EXT).then(r => r.arrayBuffer());
  cached = [{ name: 'Noto Sans', data, weight: 700, style: 'normal' }];
  return cached;
}

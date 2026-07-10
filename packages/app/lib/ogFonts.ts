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

// Satori (the WOFF2 file the "latin-ext" subset serves to modern
// browsers cannot be parsed here — Satori/opentype.js only understands
// raw TTF/OTF or WOFF (v1), not WOFF2's Brotli-compressed container.
// Requesting Google's CSS with an old-browser User-Agent gets served
// WOFF instead, and — because unicode-range subsetting is itself a
// modern-CSS feature old browsers don't get — this comes back as ONE
// unsplit font covering every block Noto Sans supports, ₦ included.
// Verified both facts before wiring this in: this exact file's cmap
// table contains U+20A6, and Satori actually renders it (this crashed
// with "Unsupported OpenType signature wOF2" against the woff2 file —
// confirmed fixed by testing against a real dev server, not assumed).
const NOTO_SANS_400 =
  'https://fonts.gstatic.com/s/notosans/v42/o-0mIpQlx3QUlC5A4PNB6Ryti20_6n1iPHjcz6L1SoM-jCpoiyD9A99e.woff';
const NOTO_SANS_700 =
  'https://fonts.gstatic.com/s/notosans/v42/o-0mIpQlx3QUlC5A4PNB6Ryti20_6n1iPHjcz6L1SoM-jCpoiyAaBN9e.woff';

let cached: OgFont[] | null = null;

export async function loadOgFonts(): Promise<OgFont[]> {
  if (cached) return cached;
  const [regular, bold] = await Promise.all([
    fetch(NOTO_SANS_400).then(r => r.arrayBuffer()),
    fetch(NOTO_SANS_700).then(r => r.arrayBuffer()),
  ]);
  cached = [
    { name: 'Noto Sans', data: regular, weight: 400, style: 'normal' },
    { name: 'Noto Sans', data: bold, weight: 700, style: 'normal' },
  ];
  return cached;
}

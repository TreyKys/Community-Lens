import { NOTO_SUBSET_400_B64, NOTO_SUBSET_700_B64 } from './ogFontData';

// Shared font loader for every next/og ImageResponse route (the OPx Picks
// card, referral card, profile accuracy card).
//
// Satori (the renderer behind ImageResponse) does NOT use system fonts —
// it only draws glyphs present in a font buffer passed via the `fonts`
// option (falling back to its own bundled font for anything missing).
// Its bundled font lacks ₦ (U+20A6 NAIRA SIGN), which is why every naira
// amount rendered as a "tofu" box until we supplied a font that has it.
//
// This font is EMBEDDED (base64, decoded here) rather than fetched from
// Google Fonts. The previous version fetched the WOFF from fonts.gstatic
// .com on every cold render with no timeout — if that fetch was slow or
// blocked from the serverless environment, the whole image render hung
// forever (a share card that never loads). Embedding removes the network
// dependency entirely: renders are fast and can't hang on an external
// fetch. It's a subset (Latin + ₦ + common symbols, ~15KB/weight);
// glyphs it lacks (e.g. the → arrow) fall back to Satori's built-in font.
//
// Decoded once per instance and cached in module scope.

type OgFont = { name: string; data: ArrayBuffer; weight: 400 | 700; style: 'normal' };

function b64ToArrayBuffer(b64: string): ArrayBuffer {
  const bin = Buffer.from(b64, 'base64');
  // Return a standalone ArrayBuffer (not a view into a pooled Node Buffer).
  return bin.buffer.slice(bin.byteOffset, bin.byteOffset + bin.byteLength);
}

let cached: OgFont[] | null = null;

export function loadOgFonts(): OgFont[] {
  if (cached) return cached;
  cached = [
    { name: 'Noto Sans', data: b64ToArrayBuffer(NOTO_SUBSET_400_B64), weight: 400, style: 'normal' },
    { name: 'Noto Sans', data: b64ToArrayBuffer(NOTO_SUBSET_700_B64), weight: 700, style: 'normal' },
  ];
  return cached;
}

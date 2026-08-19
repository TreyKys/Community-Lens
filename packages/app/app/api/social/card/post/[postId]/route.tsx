import { ImageResponse } from 'next/og';
import { createClient } from '@supabase/supabase-js';
import { resolveTheme } from '@/lib/picksThemes';
import { loadOgFonts } from '@/lib/ogFonts';
import { createSerialiser } from '@/lib/social/serialise';
import { headlineFrom, kickerFrom, pillFor, headlineSize } from '@/lib/social/cardText';

// GET /api/social/card/post/[postId]?theme=emerald
//
// The anticipation card: a queued post's own words, set as a graphic.
//
// Same visual language as the OPx Picks card — the theme gradients, the
// glow, the embedded Noto with its ₦ glyph — because that look is
// already the brand's on WhatsApp and Instagram. What differs is the
// content and what it is FOR.
//
// A Picks card REPORTS: someone took a position, here is the stake and
// the payout, past tense, settled or in flight. This card ANTICIPATES:
// something is about to happen and here is the take. So there are no
// numbers, no outcome, no user — just the line itself, large, with a
// kicker naming the subject and a status pill that says the thing has
// not happened yet.
//
// Why a card at all: a post carrying a link costs 13.3x at X's metered
// API, so the brand cannot ride in a URL. It rides in the pixels
// instead — OPINIONS.NG is burned into every one of these.

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const CARD_SIZE = { width: 1200, height: 675 };

const supabaseAdmin = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
);

// Shares the OOM guard with the market card. On a 1200 MB container an
// og render is a large, short-lived allocation, and enough at once
// would kill the process and take the site down with it.
const serialiseRender = createSerialiser();

type CardState = {
  kicker: string;
  headline: string;
  theme: string | null;
  pill: string;
};




async function loadCard(postId: string): Promise<CardState | null> {
  if (!/^\d+$/.test(postId)) return null;

  const { data: p } = await supabaseAdmin
    .from('social_posts')
    .select('body, brief, kind, card_kicker, card_theme, source_market_id')
    .eq('id', Number(postId))
    .maybeSingle();

  if (!p) return null;

  const kind = String((p as any).kind);
  return {
    kicker: (p as any).card_kicker || kickerFrom((p as any).brief, kind),
    headline: headlineFrom(String((p as any).body ?? '')),
    theme: (p as any).card_theme ?? null,
    pill: pillFor(kind, (p as any).source_market_id != null),
  };
}

export async function GET(
  req: Request,
  { params }: { params: { postId: string } },
) {
  const url = new URL(req.url);

  let state: CardState | null = null;
  try {
    state = await loadCard(params.postId);
  } catch { /* fall through to the branded fallback */ }

  // Always render something. The publisher fetches this before posting,
  // and a 500 here would cost the slot — a generic branded card is a far
  // better outcome than a missed post.
  if (!state) {
    state = { kicker: 'OPINIONS', headline: 'Nigeria’s event-derivative market', theme: null, pill: 'CALL IT' };
  }

  const theme = resolveTheme(url.searchParams.get('theme') ?? state.theme);
  const fonts = await loadOgFonts();

  // Long lines need smaller type or they overflow the frame.
  const fontSize = headlineSize(state.headline.length);

  return serialiseRender(async () => new ImageResponse(
    (
      <div
        style={{
          width: '100%',
          height: '100%',
          display: 'flex',
          flexDirection: 'column',
          justifyContent: 'space-between',
          background: `linear-gradient(160deg, ${theme.gradient[0]} 0%, ${theme.gradient[1]} 55%, ${theme.gradient[2]} 100%)`,
          fontFamily: 'Noto Sans',
          padding: '60px 68px',
          position: 'relative',
        }}
      >
        {/* themed glow, same treatment as the Picks card */}
        <div
          style={{
            position: 'absolute',
            top: -80, right: -160,
            width: 620, height: 620,
            borderRadius: 9999,
            background: theme.glow,
            filter: 'blur(130px)',
            display: 'flex',
          }}
        />

        {/* kicker — names the subject before the eye reaches the line */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
          <div
            style={{
              width: 8, height: 40, borderRadius: 4,
              background: theme.accent, display: 'flex',
            }}
          />
          <div
            style={{
              color: theme.accentSoft, fontSize: 26, fontWeight: 700,
              letterSpacing: 5, display: 'flex',
            }}
          >
            {state.kicker}
          </div>
        </div>

        {/* the line itself */}
        <div
          style={{
            display: 'flex',
            color: theme.fg,
            fontSize: fontSize,
            fontWeight: 700,
            lineHeight: 1.12,
            maxWidth: 1010,
            letterSpacing: -1,
          }}
        >
          {state.headline}
        </div>

        {/* footer: forward-looking pill, then the brand */}
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <div
            style={{
              display: 'flex', alignItems: 'center', gap: 12,
              padding: '12px 24px', borderRadius: 9999,
              background: 'rgba(255,255,255,0.10)',
            }}
          >
            <div
              style={{
                width: 12, height: 12, borderRadius: 9999,
                background: theme.accent, display: 'flex',
              }}
            />
            {/* The whole point of the card: this has not happened yet. */}
            <div style={{ color: theme.fgBody, fontSize: 24, fontWeight: 700, letterSpacing: 1 }}>
              {state.pill}
            </div>
          </div>

          {/* The brand travels here, never in a billed link. */}
          <div
            style={{
              color: theme.fg, fontSize: 30, fontWeight: 700,
              letterSpacing: 2, opacity: 0.85, display: 'flex',
            }}
          >
            OPINIONS.NG
          </div>
        </div>
      </div>
    ),
    { ...CARD_SIZE, fonts },
  ));
}

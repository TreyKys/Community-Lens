import { ImageResponse } from 'next/og';
import { createClient } from '@supabase/supabase-js';
import { resolveTheme } from '@/lib/picksThemes';
import { loadOgFonts } from '@/lib/ogFonts';

// GET /api/social/card/[marketId]?theme=emerald
//
// The market odds card: a 1200x675 PNG showing the question and where
// the money currently sits.
//
// This is the asset the whole social strategy rests on. A post with a
// link costs 13.3x at X's metered API ($0.20 vs $0.015), so the brand
// cannot travel in a URL — it has to travel in the pixels. The card
// carries "OPINIONS.NG" burned in, which is why the post body never
// needs to.
//
// 16:9 rather than the 1080x1350 of the OPx Picks card: X crops tall
// images hard in-timeline, and the split bars must be readable without
// a tap. The Picks card stays portrait because it targets IG Stories
// and WhatsApp status.
//
// PUBLIC ON PURPOSE: this renders only what the market page already
// shows any visitor — question, options, and the aggregate split. No
// user is named, no individual position is visible.

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const CARD_SIZE = { width: 1200, height: 675 };

const supabaseAdmin = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
);

type CardState = {
  question: string;
  rows: Array<{ label: string; pct: number }>;
  closesLabel: string;
  leagueLabel: string | null;
  hasRealMoney: boolean;
};

/** Mirrors lib/social/compose.ts — seed pool plus real stakes. */
function splitFromPools(m: any): Array<{ label: string; pct: number }> | null {
  const opts: string[] = Array.isArray(m.options) ? m.options : [];
  if (!opts.length) return null;

  const totals = opts.map((_, i) => {
    const real = Number(m.pool_by_outcome?.[String(i)] ?? 0);
    const seed = Number(m.seed_pool?.[String(i)] ?? 0);
    return (real > 0 ? real : 0) + (seed > 0 ? seed : 0);
  });

  const sum = totals.reduce((s, v) => s + v, 0);
  if (sum <= 0) return null;

  // Largest-remainder rounding so the bars always total exactly 100 —
  // three options at 33.3% each round to 99% and the card looks broken.
  const exact = totals.map((v) => (v / sum) * 100);
  const floored = exact.map(Math.floor);
  let remainder = 100 - floored.reduce((s, v) => s + v, 0);
  const order = exact
    .map((v, i) => ({ i, frac: v - Math.floor(v) }))
    .sort((a, b) => b.frac - a.frac);
  const pcts = [...floored];
  for (let k = 0; k < order.length && remainder > 0; k++, remainder--) {
    pcts[order[k].i]++;
  }

  return opts.map((label, i) => ({ label: String(label), pct: pcts[i] }));
}

async function loadCard(marketId: string): Promise<CardState | null> {
  const { data: m } = await supabaseAdmin
    .from('markets')
    .select('question, options, closes_at, pool_by_outcome, seed_pool, league_code, home_team, away_team')
    .eq('id', marketId)
    .maybeSingle();

  if (!m) return null;

  const rows = splitFromPools(m);
  const hasRealMoney = Object.values((m as any).pool_by_outcome ?? {}).some((v) => Number(v) > 0);

  const closes = new Date((m as any).closes_at);
  const closesLabel = Number.isFinite(closes.getTime())
    ? closes.toLocaleString('en-NG', {
        weekday: 'short', day: 'numeric', month: 'short',
        hour: '2-digit', minute: '2-digit',
        timeZone: 'Africa/Lagos', hour12: false,
      }) + ' WAT'
    : '';

  return {
    // Market questions carry a leading "[tag]" convention internally.
    question: String((m as any).question || '').replace(/\[.*?\]\s*/g, '').trim(),
    rows: rows ?? (Array.isArray((m as any).options)
      ? (m as any).options.map((o: string) => ({ label: String(o), pct: 0 }))
      : []),
    closesLabel,
    leagueLabel: (m as any).league_code || null,
    hasRealMoney,
  };
}

export async function GET(
  req: Request,
  { params }: { params: { marketId: string } },
) {
  const url = new URL(req.url);
  const theme = resolveTheme(url.searchParams.get('theme'));

  let state: CardState | null = null;
  try {
    state = await loadCard(decodeURIComponent(params.marketId));
  } catch { /* fall through */ }

  // A card always renders. The publisher uploads this image before it
  // posts — a 500 here would block the post entirely, and a generic
  // branded card is a far better outcome than a missed slot.
  if (!state) {
    state = {
      question: 'Nigeria’s event-derivative market',
      rows: [],
      closesLabel: '',
      leagueLabel: null,
      hasRealMoney: false,
    };
  }

  const fonts = await loadOgFonts();
  const rows = state.rows.slice(0, 4);
  const questionSize = state.question.length > 95 ? 44 : state.question.length > 60 ? 52 : 62;

  return new ImageResponse(
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
          padding: '56px 64px',
          position: 'relative',
        }}
      >
        <div
          style={{
            position: 'absolute',
            top: 120, right: -140,
            width: 560, height: 560,
            borderRadius: 9999,
            background: theme.glow,
            filter: 'blur(120px)',
            display: 'flex',
          }}
        />

        {/* header */}
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
            <div
              style={{
                width: 14, height: 14, borderRadius: 9999,
                background: theme.accent, display: 'flex',
              }}
            />
            <div style={{ color: theme.fgMuted, fontSize: 24, letterSpacing: 3, fontWeight: 700 }}>
              {state.hasRealMoney ? 'LIVE MARKET' : 'JUST OPENED'}
            </div>
          </div>
          {state.leagueLabel ? (
            <div style={{ color: theme.fgMuted, fontSize: 24, fontWeight: 700, letterSpacing: 2 }}>
              {state.leagueLabel}
            </div>
          ) : null}
        </div>

        {/* question */}
        <div
          style={{
            display: 'flex',
            color: theme.fg,
            fontSize: questionSize,
            fontWeight: 700,
            lineHeight: 1.15,
            maxWidth: 1020,
          }}
        >
          {state.question}
        </div>

        {/* the split — the actual product */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          {rows.map((r) => (
            <div key={r.label} style={{ display: 'flex', alignItems: 'center', gap: 20 }}>
              <div
                style={{
                  display: 'flex', color: theme.fgBody, fontSize: 28,
                  width: 300, fontWeight: 700,
                  overflow: 'hidden', whiteSpace: 'nowrap',
                }}
              >
                {r.label.length > 22 ? r.label.slice(0, 21) + '…' : r.label}
              </div>
              <div
                style={{
                  display: 'flex', flex: 1, height: 30, borderRadius: 9999,
                  background: 'rgba(255,255,255,0.10)', overflow: 'hidden',
                }}
              >
                <div
                  style={{
                    display: 'flex',
                    // Zero-width bars vanish; 2% keeps the row legible.
                    width: `${Math.max(r.pct, 2)}%`,
                    background: theme.accent,
                    borderRadius: 9999,
                  }}
                />
              </div>
              <div
                style={{
                  display: 'flex', color: theme.fg, fontSize: 34,
                  fontWeight: 700, width: 90, justifyContent: 'flex-end',
                }}
              >
                {r.pct}%
              </div>
            </div>
          ))}
        </div>

        {/* footer */}
        <div style={{ display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between' }}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            <div style={{ color: theme.fgMuted, fontSize: 22 }}>
              {state.closesLabel ? `Closes ${state.closesLabel}` : ''}
            </div>
            <div style={{ color: theme.fgMuted, fontSize: 20 }}>
              % of predictors on each outcome
            </div>
          </div>
          {/* The brand travels in the pixels, never in a billed link. */}
          <div style={{ color: theme.fg, fontSize: 30, fontWeight: 700, letterSpacing: 2, opacity: 0.85 }}>
            OPINIONS.NG
          </div>
        </div>
      </div>
    ),
    { ...CARD_SIZE, fonts },
  );
}

import { ImageResponse } from 'next/og';
import { createClient } from '@supabase/supabase-js';
import { resolveTheme } from '@/lib/picksThemes';
import { getSentimentPct } from '@/lib/sentiment';
import { loadOgFonts } from '@/lib/ogFonts';

// GET /api/picks-card/preview/slip?legs=mid:oi:odds,mid:oi:odds&stakeTngn=…&odds=…&handle=…&theme=…
//
// Pre-bet preview of the multi-leg OPx Picks share card. Visual mirror
// of /api/picks-card/slip/[id] but takes the in-flight quote inputs as
// query params so we can render before the slip row exists in
// multiplier_slips. The MultiplierSlip drawer uses this for the
// "Preview your OPx Pick" CTA so users can see exactly what their
// share card will look like before they tap Place Multiplier.
//
// `legs` format: "marketId:outcomeIndex:lockedOdds" entries joined by
// commas. lockedOdds is parsed but unused on the card itself — the
// only odds shown anywhere is the combined multiplier up top; each
// leg row shows its market status instead.

export const runtime = 'nodejs';

const CARD_SIZE = { width: 1080, height: 1350 };

const supabaseAdmin = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
);

function ngn(n: number): string {
  return '₦' + Math.round(Number(n) || 0).toLocaleString('en-NG');
}

interface ParsedLeg {
  marketId: number;
  outcomeIndex: number;
}

// The locked-odds segment in each "mid:oi:odds" entry is accepted but
// ignored — kept so existing callers (PickPreviewModal) don't need a
// URL-format change even though the card no longer shows per-leg odds.
function parseLegs(raw: string | null): ParsedLeg[] {
  if (!raw) return [];
  return raw
    .split(',')
    .map(chunk => chunk.trim())
    .filter(Boolean)
    .map(chunk => {
      const [m, o] = chunk.split(':');
      const mid = Number(m);
      const oi = Number(o);
      if (!Number.isFinite(mid) || !Number.isFinite(oi)) return null;
      return {
        marketId: mid,
        outcomeIndex: oi,
      };
    })
    .filter((x): x is ParsedLeg => x !== null)
    .slice(0, 10);
}

export async function GET(req: Request) {
  const url = new URL(req.url);
  const legs = parseLegs(url.searchParams.get('legs'));
  const stakeTngn = Math.max(0, Number(url.searchParams.get('stakeTngn')) || 0);
  const combinedOdds = Math.max(0, Number(url.searchParams.get('odds')) || 0);
  const handle = (url.searchParams.get('handle') || 'predictor')
    .replace(/[^a-zA-Z0-9_]/g, '')
    .slice(0, 18) || 'predictor';
  const theme = resolveTheme(url.searchParams.get('theme'));

  // Hydrate market metadata server-side so we control the question /
  // option label rather than trusting raw query strings.
  let hydratedLegs: Array<{ market: string; pick: string; sentimentPct: number | null }> = [];
  if (legs.length > 0) {
    try {
      const marketIds = Array.from(new Set(legs.map(l => l.marketId)));
      const { data: markets } = await supabaseAdmin
        .from('markets')
        .select('id, question, options, seed_pool')
        .in('id', marketIds);
      const byId = new Map<number, any>();
      for (const m of markets || []) byId.set(Number((m as any).id), m);
      hydratedLegs = await Promise.all(legs.map(async l => {
        const m = byId.get(l.marketId) || {};
        const opts: string[] = Array.isArray(m.options) ? m.options : [];
        const cleanQ = String(m.question || '').replace(/\[.*?\]\s*/g, '').trim() || `Market ${l.marketId}`;
        const pick = opts[l.outcomeIndex] ?? `Option ${l.outcomeIndex}`;
        const sentimentPct = await getSentimentPct(
          supabaseAdmin,
          l.marketId,
          l.outcomeIndex,
          opts.length,
          (m.seed_pool || {}) as Record<string, number>,
        );
        return {
          market: cleanQ.length > 48 ? cleanQ.slice(0, 47) + '…' : cleanQ,
          pick,
          sentimentPct,
        };
      }));
    } catch {
      // Fallback to label-only legs if the markets lookup blows up.
      hydratedLegs = legs.map(l => ({
        market: `Market ${l.marketId}`,
        pick: `Option ${l.outcomeIndex}`,
        sentimentPct: null,
      }));
    }
  }

  const payout = combinedOdds > 0 ? Math.round(stakeTngn * combinedOdds) : stakeTngn;
  const fonts = await loadOgFonts();

  return new ImageResponse(
    (
      <div
        style={{
          width: '100%',
          height: '100%',
          display: 'flex',
          flexDirection: 'column',
          background: `linear-gradient(160deg, ${theme.gradient[0]} 0%, ${theme.gradient[1]} 55%, ${theme.gradient[2]} 100%)`,
          fontFamily: 'Noto Sans',
          padding: '72px',
          position: 'relative',
        }}
      >
        <div
          style={{
            position: 'absolute',
            top: 220,
            right: -120,
            width: 720,
            height: 720,
            borderRadius: 9999,
            background: theme.glow,
            filter: 'blur(120px)',
            display: 'flex',
          }}
        />

        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            color: theme.fg,
            fontSize: 26,
            fontWeight: 800,
            letterSpacing: 4,
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
            <span style={{ color: theme.accent, display: 'flex' }}>OPx</span>
            <span style={{ display: 'flex' }}>PICKS</span>
          </div>
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 10,
              padding: '6px 14px',
              borderRadius: 9999,
              background: 'rgba(255,255,255,0.10)',
              color: theme.fgMuted,
              fontSize: 18,
              fontWeight: 800,
              letterSpacing: 2,
            }}
          >
            <span style={{ display: 'flex' }}>PREVIEW</span>
          </div>
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', marginTop: 40 }}>
          <div style={{ display: 'flex', color: theme.fgMuted, fontSize: 32, fontWeight: 600, marginBottom: 4 }}>
            My OPx Picks · Predict and Win
          </div>
          <div style={{ display: 'flex', color: theme.fg, fontSize: 56, fontWeight: 900, letterSpacing: -1, lineHeight: 1.05 }}>
            @{handle}
          </div>
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', marginTop: 56 }}>
          <div style={{ display: 'flex', alignItems: 'flex-end', gap: 14 }}>
            <span style={{ color: theme.accent, fontSize: 200, fontWeight: 900, letterSpacing: -6, lineHeight: 0.9, display: 'flex' }}>
              {combinedOdds > 0 ? combinedOdds.toFixed(2) : '—'}
            </span>
            <span style={{ color: theme.accent, fontSize: 86, fontWeight: 800, marginBottom: 18, display: 'flex' }}>
              ×
            </span>
          </div>
          <div style={{ display: 'flex', color: theme.fgBody, fontSize: 32, fontWeight: 600, marginTop: 8 }}>
            {hydratedLegs.length}-leg Multiplier · {ngn(stakeTngn)} → {ngn(payout)}
          </div>
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', marginTop: 44, gap: 14 }}>
          {hydratedLegs.slice(0, 5).map((leg, i) => (
            <div
              key={i}
              style={{
                display: 'flex',
                flexDirection: 'column',
                padding: '14px 20px',
                border: `2px solid ${theme.accent}`,
                borderRadius: 16,
                background: 'rgba(255,255,255,0.04)',
              }}
            >
              <div style={{ display: 'flex', color: theme.fgMuted, fontSize: 20, fontWeight: 600 }}>
                {leg.market}
              </div>
              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  marginTop: 4,
                }}
              >
                <span style={{ color: theme.fg, fontSize: 28, fontWeight: 800, display: 'flex' }}>
                  {leg.pick}
                </span>
                <span style={{ color: theme.accent, fontSize: 20, fontWeight: 800, display: 'flex' }}>
                  {leg.sentimentPct !== null ? `${leg.sentimentPct}% picked this` : '—'}
                </span>
              </div>
            </div>
          ))}
        </div>

        <div style={{ display: 'flex', flex: 1 }} />

        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            marginTop: 32,
          }}
        >
          <div style={{ display: 'flex', flexDirection: 'column' }}>
            <div style={{ display: 'flex', color: theme.fgMuted, fontSize: 22, fontWeight: 500 }}>
              Place your Multiplier to share.
            </div>
            <div style={{ display: 'flex', color: theme.fgBody, fontSize: 26, fontWeight: 700, marginTop: 4 }}>
              opinionsng.com
            </div>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12, opacity: 0.55 }}>
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                width: 60,
                height: 60,
                background: 'linear-gradient(135deg,#34d399,#10b981)',
                borderRadius: 14,
                color: '#050A08',
                fontSize: 18,
                fontWeight: 900,
                letterSpacing: -1,
              }}
            >
              O/N
            </div>
            <span style={{ color: theme.fg, fontSize: 22, fontWeight: 800, letterSpacing: 3, display: 'flex' }}>
              OPINIONS.NG
            </span>
          </div>
        </div>
      </div>
    ),
    {
      ...CARD_SIZE,
      fonts,
      // Same reasoning as preview/bet — deterministic given the query
      // string, so cache it. Per-leg sentiment % can drift as more
      // people bet, hence the modest window rather than caching long.
      headers: { 'cache-control': 'public, max-age=30, s-maxage=60, stale-while-revalidate=300' },
    },
  );
}

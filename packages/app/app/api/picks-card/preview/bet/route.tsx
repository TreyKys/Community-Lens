import { ImageResponse } from 'next/og';
import { createClient } from '@supabase/supabase-js';
import { resolveTheme } from '@/lib/picksThemes';
import { loadOgFonts } from '@/lib/ogFonts';

// GET /api/picks-card/preview/bet?marketId=…&outcomeIndex=…&stakeTngn=…&handle=…&theme=…
//
// Pre-bet preview of the OPx Picks share card. Same visual as the
// post-bet card route but takes the bet inputs as query params so we
// can render before the row exists in user_bets. Used by the
// "Preview your share card" CTA inside BettingInterface so the
// stake-curious can see what their share will look like before
// locking. Does NOT save anything.
//
// We still fetch the market server-side so we control the question
// and the option label rather than trusting raw query strings — keeps
// the share asset honest if the URL is shared as-is.

export const runtime = 'nodejs';

const CARD_SIZE = { width: 1080, height: 1350 };

const supabaseAdmin = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
);

function ngn(n: number): string {
  return '₦' + Math.round(Number(n) || 0).toLocaleString('en-NG');
}

export async function GET(req: Request) {
  const url = new URL(req.url);
  const marketId = Number(url.searchParams.get('marketId'));
  const outcomeIndex = Number(url.searchParams.get('outcomeIndex'));
  const stakeTngn = Math.max(0, Number(url.searchParams.get('stakeTngn')) || 0);
  const odds = Math.max(1, Number(url.searchParams.get('odds')) || 0);
  const handle = (url.searchParams.get('handle') || 'predictor').replace(/[^a-zA-Z0-9_]/g, '').slice(0, 18) || 'predictor';
  const theme = resolveTheme(url.searchParams.get('theme'));

  let headline = 'Opinions.ng prediction';
  let pickLabel = 'My pick';

  if (Number.isFinite(marketId) && marketId > 0) {
    try {
      const { data: market } = await supabaseAdmin
        .from('markets')
        .select('question, options')
        .eq('id', marketId)
        .maybeSingle();
      if (market) {
        headline = String(market.question || '').replace(/\[.*?\]\s*/g, '').trim() || headline;
        const opts: string[] = Array.isArray(market.options) ? market.options : [];
        if (Number.isInteger(outcomeIndex) && outcomeIndex >= 0 && outcomeIndex < opts.length) {
          pickLabel = opts[outcomeIndex];
        }
      }
    } catch { /* fall through to defaults */ }
  }

  const payout = odds > 0 ? Math.round(stakeTngn * odds) : stakeTngn;
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
              {odds > 0 ? odds.toFixed(2) : '—'}
            </span>
            <span style={{ color: theme.accent, fontSize: 86, fontWeight: 800, marginBottom: 18, display: 'flex' }}>
              ×
            </span>
          </div>
          <div style={{ display: 'flex', color: theme.fgBody, fontSize: 32, fontWeight: 600, marginTop: 8 }}>
            {ngn(stakeTngn)} → {ngn(payout)} if correct
          </div>
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', marginTop: 44 }}>
          <div style={{ display: 'flex', color: theme.fgMuted, fontSize: 28, fontWeight: 600, marginBottom: 6 }}>
            {headline.length > 80 ? headline.slice(0, 79) + '…' : headline}
          </div>
          <div
            style={{
              display: 'flex',
              padding: '20px 28px',
              borderRadius: 18,
              border: `2px solid ${theme.accent}`,
              color: theme.fg,
              fontSize: 44,
              fontWeight: 900,
              background: 'rgba(255,255,255,0.04)',
            }}
          >
            {pickLabel}
          </div>
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
              Lock your prediction to share.
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
    { ...CARD_SIZE, fonts },
  );
}

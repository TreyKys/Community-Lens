import { ImageResponse } from 'next/og';
import { createClient } from '@supabase/supabase-js';
import { loadOgFonts } from '@/lib/ogFonts';

// GET /api/card/[userId] → 1080×1350 PNG "accuracy card".
//
// This is the shareable flex asset — the Spotify-Wrapped-style stat card a
// user drops on WhatsApp status / X to show off their forecasting record.
// It doubles as the OG image for the public /u/[userId] landing page, so a
// shared link unfurls straight into this card. Every share is free
// acquisition attached to a credibility signal.
//
// PUBLIC ON PURPOSE: link unfurlers (WhatsApp, X, Telegram) fetch this with
// no session, so it can't be auth-gated. It therefore exposes ONLY vanity
// data — username, accuracy %, prediction counts. Never balance, never
// money, never email.
//
// NB: `size` / `contentType` are reserved exports for Next's special
// opengraph-image.tsx file convention, NOT for route handlers — declaring
// them here trips the route type-checker. We pass dimensions through the
// ImageResponse options instead, and the content type is image/png by
// default.

export const runtime = 'nodejs';

const CARD_SIZE = { width: 1080, height: 1350 };

const supabaseAdmin = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
);

// Milestone tier from accuracy. Everyone with a real sample gets a
// positive label worth sharing — the floor is "Contender", never an
// insult. Thresholds mirror the accuracy-privilege ladder (65/70/75/80).
function tierFor(accuracy: number, resolved: number): { label: string; color: string; glow: string } {
  if (resolved < 5)   return { label: 'ROOKIE',          color: '#94a3b8', glow: 'rgba(148,163,184,0.25)' };
  if (accuracy >= 80) return { label: 'PRO FORECASTER',  color: '#fbbf24', glow: 'rgba(251,191,36,0.35)' };
  if (accuracy >= 75) return { label: 'ELITE FORECASTER',color: '#f59e0b', glow: 'rgba(245,158,11,0.30)' };
  if (accuracy >= 70) return { label: 'TOP FORECASTER',  color: '#34d399', glow: 'rgba(52,211,153,0.30)' };
  if (accuracy >= 60) return { label: 'SHARP',           color: '#22d3ee', glow: 'rgba(34,211,238,0.28)' };
  if (accuracy >= 50) return { label: 'RISING',          color: '#a78bfa', glow: 'rgba(167,139,250,0.28)' };
  return { label: 'CONTENDER', color: '#94a3b8', glow: 'rgba(148,163,184,0.2)' };
}

export async function GET(_req: Request, { params }: { params: { userId: string } }) {
  let handle = 'predictor';
  let accuracy = 0;
  let resolved = 0;
  let won = 0;

  try {
    const { data: user } = await supabaseAdmin
      .from('users')
      .select('username, first_name')
      .eq('id', params.userId)
      .maybeSingle();
    if (user) handle = (user.username || user.first_name || 'predictor').replace(/\s+/g, '').slice(0, 18);

    const { data: bets } = await supabaseAdmin
      .from('user_bets')
      .select('status')
      .eq('user_id', params.userId);
    if (bets) {
      won = bets.filter(b => b.status === 'won').length;
      const lost = bets.filter(b => b.status === 'lost').length;
      resolved = won + lost;
      accuracy = resolved > 0 ? Math.round((won / resolved) * 100) : 0;
    }
  } catch {
    /* fall through to defaults — a card always renders */
  }

  const tier = tierFor(accuracy, resolved);
  const fonts = await loadOgFonts();

  return new ImageResponse(
    (
      <div
        style={{
          width: '100%',
          height: '100%',
          display: 'flex',
          flexDirection: 'column',
          background: 'linear-gradient(160deg, #050A08 0%, #07231A 55%, #0A3A2C 100%)',
          fontFamily: 'Noto Sans',
          padding: '72px',
          position: 'relative',
        }}
      >
        {/* glow blob */}
        <div
          style={{
            position: 'absolute',
            top: 280,
            left: 140,
            width: 800,
            height: 800,
            borderRadius: 9999,
            background: tier.glow,
            filter: 'blur(120px)',
            display: 'flex',
          }}
        />

        {/* header */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 18 }}>
          <div
            style={{
              width: 60,
              height: 60,
              background: 'linear-gradient(135deg,#34d399,#10b981)',
              borderRadius: 16,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              color: '#050A08',
              fontSize: 18,
              fontWeight: 900,
              letterSpacing: -1,
            }}
          >
            O/N
          </div>
          <div style={{ display: 'flex', color: '#ffffff', fontSize: 32, fontWeight: 800, letterSpacing: 3 }}>
            OPINIONS.NG
          </div>
        </div>

        {/* tier badge */}
        <div style={{ display: 'flex', marginTop: 90 }}>
          <div
            style={{
              display: 'flex',
              padding: '14px 28px',
              borderRadius: 9999,
              border: `2px solid ${tier.color}`,
              color: tier.color,
              fontSize: 30,
              fontWeight: 800,
              letterSpacing: 4,
            }}
          >
            {tier.label}
          </div>
        </div>

        {/* the number */}
        <div style={{ display: 'flex', flexDirection: 'column', marginTop: 40 }}>
          <div style={{ display: 'flex', alignItems: 'flex-end' }}>
            <div style={{ display: 'flex', color: tier.color, fontSize: 360, fontWeight: 900, lineHeight: 0.9, letterSpacing: -8 }}>
              {accuracy}
            </div>
            <div style={{ display: 'flex', color: tier.color, fontSize: 120, fontWeight: 800, marginBottom: 56 }}>%</div>
          </div>
          <div style={{ display: 'flex', color: '#cbd5e1', fontSize: 40, fontWeight: 600, marginTop: 4, letterSpacing: 2 }}>
            FORECAST ACCURACY
          </div>
        </div>

        {/* handle + record */}
        <div style={{ display: 'flex', flexDirection: 'column', marginTop: 70 }}>
          <div style={{ display: 'flex', color: '#ffffff', fontSize: 56, fontWeight: 800 }}>@{handle}</div>
          <div style={{ display: 'flex', color: '#7c8a9a', fontSize: 30, fontWeight: 500, marginTop: 10 }}>
            {won} correct · {resolved} resolved predictions
          </div>
        </div>

        <div style={{ display: 'flex', flex: 1 }} />

        {/* footer CTA */}
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <div style={{ display: 'flex', color: '#94a3b8', fontSize: 30, fontWeight: 500 }}>
            Think you can call it better?
          </div>
          <div
            style={{
              display: 'flex',
              padding: '16px 30px',
              background: '#10b981',
              color: '#050A08',
              borderRadius: 14,
              fontSize: 30,
              fontWeight: 800,
            }}
          >
            opinionsng.com
          </div>
        </div>
      </div>
    ),
    {
      ...CARD_SIZE,
      fonts,
      // Accuracy stats move as bets settle, but not fast enough to
      // justify re-rendering on every request.
      headers: { 'cache-control': 'public, max-age=60, s-maxage=300, stale-while-revalidate=3600' },
    },
  );
}

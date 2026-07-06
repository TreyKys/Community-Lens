import { ImageResponse } from 'next/og';

// Branded social-share image. Next.js compiles this into the OG/Twitter
// card preview that's used when someone drops an opinionsng.com link
// in WhatsApp, Telegram, X, Slack, etc. Without it the preview is just
// blank gray text — a credibility hit before the user even clicks.
//
// Per-page OG images can be added later by dropping an opengraph-image
// (or opengraph-image.tsx) into a route's folder; this one is the
// site-wide default.

export const runtime = 'edge';
export const size = { width: 1200, height: 630 };
export const contentType = 'image/png';

export const alt = "Opinions.ng — Nigeria's Event-Prediction Market";

export default function OpengraphImage() {
  return new ImageResponse(
    (
      <div
        style={{
          width: '100%',
          height: '100%',
          display: 'flex',
          flexDirection: 'column',
          justifyContent: 'space-between',
          padding: '80px',
          background: 'linear-gradient(135deg, #050A08 0%, #07221A 60%, #0B3B2E 100%)',
          fontFamily: 'sans-serif',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 18 }}>
          <div
            style={{
              width: 56,
              height: 56,
              background: 'linear-gradient(135deg,#34d399,#10b981)',
              borderRadius: 14,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              color: '#050A08',
              fontSize: 30,
              fontWeight: 900,
            }}
          >
            ◈
          </div>
          <div
            style={{
              color: '#ffffff',
              fontSize: 30,
              fontWeight: 800,
              letterSpacing: 2,
            }}
          >
            OPINIONS.NG
          </div>
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 24 }}>
          <div
            style={{
              color: '#ffffff',
              fontSize: 76,
              fontWeight: 800,
              lineHeight: 1.05,
              letterSpacing: -1,
              maxWidth: 980,
            }}
          >
            Nigeria&rsquo;s event-prediction market.
          </div>
          <div
            style={{
              color: '#a7f3d0',
              fontSize: 30,
              fontWeight: 500,
              lineHeight: 1.3,
              maxWidth: 920,
            }}
          >
            Predict football, politics, pop culture and the economy. Settle in Naira. Sealed on Polygon.
          </div>
        </div>

        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <div style={{ color: '#94a3b8', fontSize: 22, fontWeight: 500 }}>opinionsng.com</div>
          <div
            style={{
              padding: '12px 22px',
              background: '#10b981',
              color: '#050A08',
              borderRadius: 10,
              fontSize: 22,
              fontWeight: 800,
              letterSpacing: 0.5,
            }}
          >
            Take a position →
          </div>
        </div>
      </div>
    ),
    { ...size },
  );
}

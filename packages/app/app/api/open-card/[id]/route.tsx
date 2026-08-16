import { ImageResponse } from 'next/og';
import { createClient } from '@supabase/supabase-js';
import { loadOgFonts } from '@/lib/ogFonts';
import { createSerialiser } from '@/lib/social/serialise';
import { pricesFromQ } from '@/lib/openMarketTypes';

// GET /api/open-card/[id] — the unfurl image for an open market.
//
// "Share and earn" needs something worth sharing, and in Nigeria that means a
// WhatsApp preview. A bare link previews as a domain and gets ignored; the
// question and the current odds have to travel in the pixels.
//
// 1200x675 to match the market card: WhatsApp and X both crop tall images hard
// in-timeline, and the odds must be readable without opening anything.
//
// PUBLIC ON PURPOSE: renders only what the market page already shows any
// visitor — the question, the options, and where the money currently sits. No
// user is named and no individual position is visible.

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const CARD = { width: 1200, height: 675 };

// Serialised for the same reason every other card route is: a burst of
// unfurlers must not OOM the container and take the whole site down.
const serialiseRender = createSerialiser();

const supabaseAdmin = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
);

const BG = '#07120E';
const FG = '#E8F5EF';
const MUTED = '#7FA593';
const ACCENT = '#22C55E';

export async function GET(_req: Request, { params }: { params: { id: string } }) {
  const { data: m } = await supabaseAdmin
    .from('open_markets')
    .select('question, outcomes, q, b, status, fees_collected')
    .eq('id', params.id)
    .maybeSingle();

  // Unapproved markets must not be discoverable, and an unfurl is discovery.
  const visible = m && !['pending_review', 'revise', 'rejected'].includes((m as any).status);

  const question = visible ? String((m as any).question) : 'Opinions.ng';
  const outcomes: string[] = visible ? ((m as any).outcomes || []) : [];
  const prices = visible ? pricesFromQ((m as any).q, (m as any).b) : [];

  // Show the strongest four so a busy multi-outcome market stays readable.
  const rows = outcomes
    .map((label, i) => ({ label, pct: prices[i] ?? 0 }))
    .sort((a, b) => b.pct - a.pct)
    .slice(0, 4);

  const fonts = loadOgFonts();

  return serialiseRender(async () => new ImageResponse(
    (
      <div style={{
        width: '100%', height: '100%', display: 'flex', flexDirection: 'column',
        background: BG, padding: 64, fontFamily: 'Noto Sans',
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <div style={{ width: 14, height: 14, borderRadius: 7, background: ACCENT }} />
          <div style={{ fontSize: 22, color: MUTED, letterSpacing: 2, fontWeight: 700 }}>
            OPINIONS.NG · OPEN MARKET
          </div>
        </div>

        <div style={{
          fontSize: question.length > 90 ? 44 : 54, color: FG, fontWeight: 700,
          lineHeight: 1.18, marginTop: 28, display: 'flex', flex: 1,
        }}>
          {question}
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          {rows.map((r, i) => (
            <div key={i} style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                <div style={{ fontSize: 28, color: FG }}>{r.label}</div>
                <div style={{ fontSize: 28, color: i === 0 ? ACCENT : MUTED, fontWeight: 700 }}>
                  {Math.round(r.pct * 100)}%
                </div>
              </div>
              <div style={{ display: 'flex', width: '100%', height: 10, background: '#122A20', borderRadius: 5 }}>
                <div style={{
                  width: `${Math.max(2, Math.round(r.pct * 100))}%`, height: 10,
                  background: i === 0 ? ACCENT : '#2F6B51', borderRadius: 5, display: 'flex',
                }} />
              </div>
            </div>
          ))}
        </div>

        <div style={{ display: 'flex', marginTop: 26, fontSize: 22, color: MUTED }}>
          {visible
            ? 'Buy a side. Sell any time — you don’t have to wait for the answer.'
            : 'Real predictions, real money.'}
        </div>
      </div>
    ),
    { ...CARD, fonts },
  ));
}

import { ImageResponse } from 'next/og';
import { createClient } from '@supabase/supabase-js';
import { resolveTheme } from '@/lib/picksThemes';
import { getSentimentPct } from '@/lib/sentiment';
import { loadOgFonts } from '@/lib/ogFonts';

// GET /api/picks-card/[type]/[id]?theme=violet
//
// 1080×1350 PNG OPx Picks share card. Sized like a Spotify "Wrapped"
// share — fits an Instagram Story crop without letterboxing, drops
// onto a WhatsApp status without scaling artifacts, and works as the
// OG image when the /p/[type]/[id] link unfurls.
//
// PUBLIC ON PURPOSE: unfurlers fetch this with no session. user_bets
// and multiplier_slips are RLS-locked to the owner; we read via
// service-role here. The card surfaces ONLY vanity data — the
// inviter's @handle, the market question, the picked outcome, the
// stake, and the projected/actual payout. Never balance, never email,
// never opposing-side info.
//
// The "OPx" branding sits transparent in the bottom-right corner the
// same way Spotify's logo does, regardless of theme.

export const runtime = 'nodejs';

const CARD_SIZE = { width: 1080, height: 1350 };

const supabaseAdmin = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
);

function ngn(n: number): string {
  return '₦' + Math.round(Number(n) || 0).toLocaleString('en-NG');
}

function bestHandle(u: { username?: string | null; first_name?: string | null } | null): string {
  if (!u) return 'predictor';
  return (u.username || u.first_name || 'predictor').replace(/\s+/g, '').slice(0, 18);
}

interface CardState {
  handle: string;
  // null for slip; the single bet's label for type=bet
  betLabel: string | null;
  // null for bet; multi-line legs for type=slip. Never per-leg odds —
  // the only odds shown on this card is the combined multiplier up
  // top. Each leg shows the live "% of predictors picked this" instead.
  slipLegs: Array<{ market: string; pick: string; sentimentPct: number | null }>;
  stakeTngn: number;
  // For a single bet: the projected/floor payout
  // For a slip: payout = stake × combined
  payoutTngn: number;
  // For singles, the locked odds; for slips, the combined odds
  odds: number;
  // The market headline (for singles) or "N-leg Multiplier" (for slips)
  headline: string;
  // The slip leg count, for the chip
  slipLegCount: number;
  isSlip: boolean;
  // Status pill — keeps the share honest about whether the pick is
  // still in play or already resolved. 'live' = still active.
  statusKind: 'live' | 'won' | 'lost' | 'refunded' | 'voided';
}

async function loadCard(type: string, id: string): Promise<CardState | null> {
  if (type === 'bet') {
    const { data: bet } = await supabaseAdmin
      .from('user_bets')
      .select('user_id, market_id, outcome_index, stake_tngn, payout_tngn, locked_odds, status, markets:market_id (question, options)')
      .eq('id', id)
      .maybeSingle();
    if (!bet) return null;

    const { data: owner } = await supabaseAdmin
      .from('users')
      .select('username, first_name')
      .eq('id', bet.user_id)
      .maybeSingle();

    const m: any = (bet as any).markets || {};
    const opts: string[] = Array.isArray(m.options) ? m.options : [];
    const pickLabel = opts[bet.outcome_index] ?? `Option ${bet.outcome_index}`;
    const cleanQ = String(m.question || '').replace(/\[.*?\]\s*/g, '').trim();

    const stake = Number(bet.stake_tngn || 0);
    const lockedOdds = bet.locked_odds == null ? null : Number(bet.locked_odds);
    const payout = bet.payout_tngn != null
      ? Number(bet.payout_tngn)
      : lockedOdds
        ? Math.round(stake * lockedOdds)
        : stake;

    const betStatus = String((bet as any).status || 'active');
    const statusKind: CardState['statusKind'] =
      betStatus === 'won'      ? 'won'      :
      betStatus === 'lost'     ? 'lost'     :
      betStatus === 'refunded' ? 'refunded' :
                                 'live';
    return {
      handle: bestHandle(owner),
      betLabel: pickLabel,
      slipLegs: [],
      stakeTngn: stake,
      payoutTngn: payout,
      odds: lockedOdds ?? (payout > 0 && stake > 0 ? payout / stake : 0),
      headline: cleanQ || 'Opinions.ng prediction',
      slipLegCount: 0,
      isSlip: false,
      statusKind,
    };
  }

  if (type === 'slip') {
    const { data: slip } = await supabaseAdmin
      .from('multiplier_slips')
      .select(`
        user_id, slip_stake_tngn, combined_odds, payout_tngn, final_payout_tngn,
        legs_total, status,
        multiplier_legs (
          market_id, outcome_index, locked_odds,
          markets:market_id (question, options, seed_pool)
        )
      `)
      .eq('id', id)
      .maybeSingle();
    if (!slip) return null;

    const { data: owner } = await supabaseAdmin
      .from('users')
      .select('username, first_name')
      .eq('id', (slip as any).user_id)
      .maybeSingle();

    const legsRaw = Array.isArray((slip as any).multiplier_legs) ? (slip as any).multiplier_legs : [];
    const legs = await Promise.all(legsRaw.map(async (l: any) => {
      const m = l.markets || {};
      const opts: string[] = Array.isArray(m.options) ? m.options : [];
      const cleanQ = String(m.question || '').replace(/\[.*?\]\s*/g, '').trim();
      const sentimentPct = await getSentimentPct(
        supabaseAdmin,
        l.market_id,
        Number(l.outcome_index),
        opts.length,
        (m.seed_pool || {}) as Record<string, number>,
      );
      return {
        market: cleanQ.length > 48 ? cleanQ.slice(0, 47) + '…' : cleanQ,
        pick: opts[l.outcome_index] ?? `Option ${l.outcome_index}`,
        sentimentPct,
      };
    }));

    const stake = Number((slip as any).slip_stake_tngn || 0);
    const payout = (slip as any).final_payout_tngn != null
      ? Number((slip as any).final_payout_tngn)
      : Number((slip as any).payout_tngn || 0);

    const slipStatus = String((slip as any).status || 'active');
    const statusKind: CardState['statusKind'] =
      slipStatus === 'won'    ? 'won'      :
      slipStatus === 'lost'   ? 'lost'     :
      slipStatus === 'voided' ? 'voided'   :
                                'live';
    return {
      handle: bestHandle(owner),
      betLabel: null,
      slipLegs: legs,
      stakeTngn: stake,
      payoutTngn: payout,
      odds: Number((slip as any).combined_odds || 0),
      headline: `${legs.length}-leg Multiplier`,
      slipLegCount: legs.length,
      isSlip: true,
      statusKind,
    };
  }

  return null;
}

export async function GET(
  req: Request,
  { params }: { params: { type: string; id: string } },
) {
  const url = new URL(req.url);
  const theme = resolveTheme(url.searchParams.get('theme'));

  let state: CardState | null = null;
  try {
    state = await loadCard(params.type, params.id);
  } catch { /* fall through to fallback */ }

  // Fallback — a card always renders even if the lookup fails. Better
  // than a broken unfurl preview.
  if (!state) {
    state = {
      handle: 'predictor',
      betLabel: null,
      slipLegs: [],
      stakeTngn: 0,
      payoutTngn: 0,
      odds: 0,
      headline: 'OPx Picks · Opinions.ng',
      slipLegCount: 0,
      isSlip: false,
      statusKind: 'live',
    };
  }

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
        {/* themed glow blob */}
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

        {/* eyebrow + state pill — the pill keeps the share honest about
            whether the inviter's pick is still in play or already
            settled. Active = LIVE (green dot pulse-style). */}
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
          {(() => {
            const pillMap: Record<typeof state.statusKind, { label: string; bg: string; fg: string; dotBg: string }> = {
              live:     { label: 'LIVE',     bg: 'rgba(52,211,153,0.18)',  fg: '#34d399', dotBg: '#34d399' },
              won:      { label: 'WON',      bg: 'rgba(52,211,153,0.18)',  fg: '#34d399', dotBg: '#34d399' },
              lost:     { label: 'MISSED',   bg: 'rgba(239,68,68,0.18)',   fg: '#fca5a5', dotBg: '#fca5a5' },
              refunded: { label: 'REFUNDED', bg: 'rgba(251,191,36,0.18)',  fg: '#fbbf24', dotBg: '#fbbf24' },
              voided:   { label: 'REFUNDED', bg: 'rgba(251,191,36,0.18)',  fg: '#fbbf24', dotBg: '#fbbf24' },
            };
            const pill = pillMap[state!.statusKind];
            return (
              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 10,
                  padding: '6px 14px',
                  borderRadius: 9999,
                  background: pill.bg,
                  color: pill.fg,
                  fontSize: 18,
                  fontWeight: 800,
                  letterSpacing: 2,
                }}
              >
                <span
                  style={{
                    width: 10,
                    height: 10,
                    borderRadius: 9999,
                    background: pill.dotBg,
                    display: 'flex',
                  }}
                />
                <span style={{ display: 'flex' }}>{pill.label}</span>
              </div>
            );
          })()}
        </div>

        {/* hero */}
        <div style={{ display: 'flex', flexDirection: 'column', marginTop: 40 }}>
          <div
            style={{
              display: 'flex',
              color: theme.fgMuted,
              fontSize: 32,
              fontWeight: 600,
              marginBottom: 4,
            }}
          >
            My OPx Picks · Predict and Win
          </div>
          <div
            style={{
              display: 'flex',
              color: theme.fg,
              fontSize: 56,
              fontWeight: 900,
              letterSpacing: -1,
              lineHeight: 1.05,
            }}
          >
            @{state.handle}
          </div>
        </div>

        {/* odds + payout headline */}
        <div style={{ display: 'flex', flexDirection: 'column', marginTop: 56 }}>
          <div
            style={{
              display: 'flex',
              alignItems: 'flex-end',
              gap: 14,
            }}
          >
            <span
              style={{
                color: theme.accent,
                fontSize: 200,
                fontWeight: 900,
                letterSpacing: -6,
                lineHeight: 0.9,
                display: 'flex',
              }}
            >
              {state.odds > 0 ? state.odds.toFixed(2) : '—'}
            </span>
            <span
              style={{
                color: theme.accent,
                fontSize: 86,
                fontWeight: 800,
                marginBottom: 18,
                display: 'flex',
              }}
            >
              ×
            </span>
          </div>
          <div
            style={{
              display: 'flex',
              color: theme.fgBody,
              fontSize: 32,
              fontWeight: 600,
              marginTop: 8,
            }}
          >
            {state.isSlip
              ? `${state.slipLegCount}-leg Multiplier · ${ngn(state.stakeTngn)} → ${ngn(state.payoutTngn)}`
              : `${ngn(state.stakeTngn)} → ${ngn(state.payoutTngn)} if correct`}
          </div>
        </div>

        {/* pick(s) */}
        <div style={{ display: 'flex', flexDirection: 'column', marginTop: 44 }}>
          {state.isSlip ? (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
              {state.slipLegs.slice(0, 5).map((leg, i) => (
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
                  <div
                    style={{
                      display: 'flex',
                      color: theme.fgMuted,
                      fontSize: 20,
                      fontWeight: 600,
                    }}
                  >
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
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column' }}>
              <div
                style={{
                  display: 'flex',
                  color: theme.fgMuted,
                  fontSize: 28,
                  fontWeight: 600,
                  marginBottom: 6,
                }}
              >
                {state.headline}
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
                {state.betLabel || 'My pick'}
              </div>
            </div>
          )}
        </div>

        {/* spacer */}
        <div style={{ display: 'flex', flex: 1 }} />

        {/* footer + transparent O/N */}
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            marginTop: 32,
          }}
        >
          <div
            style={{
              display: 'flex',
              flexDirection: 'column',
            }}
          >
            <div
              style={{
                display: 'flex',
                color: theme.fgMuted,
                fontSize: 22,
                fontWeight: 500,
              }}
            >
              Tap to copy. Tap to predict.
            </div>
            <div
              style={{
                display: 'flex',
                color: theme.fgBody,
                fontSize: 26,
                fontWeight: 700,
                marginTop: 4,
              }}
            >
              opinionsng.com
            </div>
          </div>

          {/* Transparent O/N branding — sits in the bottom-right corner
              like the small Spotify mark on a Wrapped share. Same
              opacity across every theme so it reads as a watermark not
              a competing logo. */}
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 12,
              opacity: 0.55,
            }}
          >
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
      // No caching at all was the actual reason theme-switching in the
      // share modal felt "stubborn and slow" — every click (including
      // re-clicking a theme already viewed) re-ran the full Supabase
      // lookup + Satori render + PNG encode from scratch. Status can
      // still change (live → won/lost), so keep the window modest
      // rather than caching indefinitely.
      headers: { 'cache-control': 'public, max-age=30, s-maxage=60, stale-while-revalidate=300' },
    },
  );
}

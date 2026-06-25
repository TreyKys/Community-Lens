import { ImageResponse } from 'next/og';
import { createClient } from '@supabase/supabase-js';

// GET /api/referral-card/[code] → 1200×630 PNG link-unfurl card.
//
// This is the preview that renders when a user drops their referral
// link (opinionsng.com/r/CODE) on WhatsApp / X / Telegram. Landscape
// 1200×630 is the standard OG ratio those unfurlers crop to.
//
// PUBLIC ON PURPOSE: link unfurlers fetch with no session. The
// referral_codes table is RLS-locked to the owner, so we read via
// service-role here. Exposes only vanity + offer data — the
// referrer's handle, whether it's a VIP code, and the signup bonus.
// Never balances, never email.

export const runtime = 'nodejs';

const CARD_SIZE = { width: 1200, height: 630 };

const supabaseAdmin = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
);

export async function GET(_req: Request, { params }: { params: { code: string } }) {
  const rawCode = (params.code || '').trim().toUpperCase().slice(0, 32);

  let handle = 'a friend';
  let isVip = false;
  let bonus = 0;
  let valid = false;

  try {
    const { data: codeRow } = await supabaseAdmin
      .from('referral_codes')
      .select('code, owner_user_id, is_vip_code, signup_bonus_tngn, is_active')
      .ilike('code', rawCode)
      .maybeSingle();

    if (codeRow && codeRow.is_active) {
      valid = true;
      isVip = !!codeRow.is_vip_code;
      bonus = Number(codeRow.signup_bonus_tngn || 0);
      const { data: owner } = await supabaseAdmin
        .from('users')
        .select('username, first_name')
        .eq('id', codeRow.owner_user_id)
        .maybeSingle();
      if (owner) handle = (owner.username || owner.first_name || 'a friend').replace(/\s+/g, '').slice(0, 18);
    }
  } catch {
    /* fall through to defaults — a card always renders */
  }

  const accent = isVip ? '#fbbf24' : '#34d399';
  const accentGlow = isVip ? 'rgba(251,191,36,0.30)' : 'rgba(52,211,153,0.28)';

  return new ImageResponse(
    (
      <div
        style={{
          width: '100%',
          height: '100%',
          display: 'flex',
          flexDirection: 'column',
          justifyContent: 'space-between',
          background: 'linear-gradient(135deg, #050A08 0%, #07231A 55%, #0A3A2C 100%)',
          fontFamily: 'sans-serif',
          padding: '64px 72px',
          position: 'relative',
        }}
      >
        {/* glow blob */}
        <div
          style={{
            position: 'absolute',
            top: -120,
            right: -80,
            width: 560,
            height: 560,
            borderRadius: 9999,
            background: accentGlow,
            filter: 'blur(120px)',
            display: 'flex',
          }}
        />

        {/* header */}
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
              fontSize: 26,
              fontWeight: 900,
              letterSpacing: -1,
            }}
          >
            O/N
          </div>
          <div style={{ display: 'flex', color: '#ffffff', fontSize: 30, fontWeight: 800, letterSpacing: 3 }}>
            OPINIONS.NG
          </div>
          {isVip && (
            <div
              style={{
                display: 'flex',
                marginLeft: 8,
                padding: '6px 16px',
                borderRadius: 9999,
                border: `2px solid ${accent}`,
                color: accent,
                fontSize: 20,
                fontWeight: 800,
                letterSpacing: 2,
              }}
            >
              VIP INVITE
            </div>
          )}
        </div>

        {/* body */}
        <div style={{ display: 'flex', flexDirection: 'column' }}>
          <div style={{ display: 'flex', color: '#94a3b8', fontSize: 34, fontWeight: 600 }}>
            @{handle} is inviting you to
          </div>
          <div style={{ display: 'flex', color: '#ffffff', fontSize: 76, fontWeight: 900, letterSpacing: -2, lineHeight: 1.05, marginTop: 8 }}>
            Nigeria&rsquo;s prediction market
          </div>
          {bonus > 0 && (
            <div style={{ display: 'flex', alignItems: 'center', marginTop: 28 }}>
              <div
                style={{
                  display: 'flex',
                  padding: '14px 28px',
                  borderRadius: 14,
                  background: accent,
                  color: '#050A08',
                  fontSize: 34,
                  fontWeight: 900,
                }}
              >
                ₦{bonus.toLocaleString()} sign-up bonus
              </div>
            </div>
          )}
        </div>

        {/* footer */}
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <div style={{ display: 'flex', flexDirection: 'column' }}>
            <div style={{ display: 'flex', color: '#64748b', fontSize: 22, fontWeight: 500 }}>
              {valid ? 'Code applied automatically' : 'Football · Politics · Crypto · Economy'}
            </div>
            <div style={{ display: 'flex', color: accent, fontSize: 38, fontWeight: 800, letterSpacing: 4, marginTop: 4 }}>
              {valid ? rawCode : 'OPINIONSNG.COM'}
            </div>
          </div>
          <div
            style={{
              display: 'flex',
              padding: '16px 32px',
              background: '#10b981',
              color: '#050A08',
              borderRadius: 14,
              fontSize: 28,
              fontWeight: 800,
            }}
          >
            Join free →
          </div>
        </div>
      </div>
    ),
    { ...CARD_SIZE },
  );
}

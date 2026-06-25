import type { Metadata } from 'next';
import { createClient } from '@supabase/supabase-js';
import { ReferralLandingClient } from './ReferralLandingClient';

// Public referral landing page. A VIP (or any user) shares
// opinionsng.com/r/CODE; the link unfurls into the referral card (OG
// image below) and anyone who taps it lands here. The code is captured
// + locked into the signup form automatically — see
// ReferralLandingClient. No auth: top of the acquisition funnel.

export const revalidate = 300;

const SITE = 'https://opinionsng.com';

async function loadCode(code: string) {
  const clean = (code || '').trim().toUpperCase().slice(0, 32);
  if (!clean) return null;
  try {
    const db = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.SUPABASE_SERVICE_ROLE_KEY!,
    );
    const { data: codeRow } = await db
      .from('referral_codes')
      .select('code, owner_user_id, is_vip_code, signup_bonus_tngn, is_active')
      .ilike('code', clean)
      .maybeSingle();
    if (!codeRow || !codeRow.is_active) return null;

    const { data: owner } = await db
      .from('users')
      .select('username, first_name')
      .eq('id', codeRow.owner_user_id)
      .maybeSingle();

    return {
      code: codeRow.code as string,
      handle: ((owner?.username || owner?.first_name || 'a friend') as string).replace(/\s+/g, '').slice(0, 18),
      isVip: !!codeRow.is_vip_code,
      bonus: Number(codeRow.signup_bonus_tngn || 0),
    };
  } catch {
    return null;
  }
}

export async function generateMetadata({ params }: { params: { code: string } }): Promise<Metadata> {
  const info = await loadCode(params.code);
  const cardUrl = `${SITE}/api/referral-card/${encodeURIComponent(params.code)}`;
  const title = info
    ? `@${info.handle} invited you to Opinions.ng`
    : 'Join Opinions.ng — Nigeria&rsquo;s prediction market';
  const description = info
    ? `Sign up with @${info.handle}&rsquo;s code${info.bonus > 0 ? ` and claim a ₦${info.bonus.toLocaleString()} bonus` : ''}. Football, politics, crypto, the economy — take a position and get paid for being right.`
    : "Nigeria's event-prediction market. Take a position and get paid for being right.";

  return {
    title,
    description,
    openGraph: {
      title,
      description,
      url: `${SITE}/r/${encodeURIComponent(params.code)}`,
      images: [{ url: cardUrl, width: 1200, height: 630 }],
    },
    twitter: {
      card: 'summary_large_image',
      title,
      description,
      images: [cardUrl],
    },
  };
}

export default async function ReferralLandingPage({ params }: { params: { code: string } }) {
  const info = await loadCode(params.code);
  // Even if the code is unknown/inactive, still capture the raw string —
  // the redeem endpoint is the real validator, and a typo'd-but-stashed
  // code just no-ops there rather than silently dropping a real invite.
  const rawCode = (params.code || '').trim().toUpperCase().slice(0, 32);

  return (
    <ReferralLandingClient
      code={info?.code || rawCode}
      handle={info?.handle || null}
      isVip={info?.isVip ?? false}
      bonus={info?.bonus ?? 0}
      valid={!!info}
    />
  );
}

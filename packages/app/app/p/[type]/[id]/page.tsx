import type { Metadata } from 'next';
import { createClient } from '@supabase/supabase-js';
import { notFound } from 'next/navigation';
import { PicksLandingClient } from './PicksLandingClient';

// Public OPx Picks landing page.
// URL: opinionsng.com/p/bet/<bet-id> or /p/slip/<slip-id>
//
// The link unfurls into the OG image at /api/picks-card/[type]/[id]
// (1080×1350, theme-able). When a visitor opens the link, this server
// component renders the page metadata + hands off to the client
// component which shows the inline card preview and the two CTAs
// ("Stake as is" and "Make It Yours — Clone & Edit").
//
// Theme is propagated via ?theme=... so the OG image, the inline
// preview, and the modal frame all stay in sync.

export const revalidate = 60;

const SITE = 'https://opinionsng.com';

interface InitialData {
  type: 'bet' | 'slip';
  id: string;
  ownerHandle: string;
  marketQuestion: string;
  pickLabel: string;
  oddsLabel: string;
  stakeTngn: number;
  payoutTngn: number;
}

async function loadInitial(type: string, id: string): Promise<InitialData | null> {
  const t = (type || '').toLowerCase();
  if (t !== 'bet' && t !== 'slip') return null;

  try {
    const db = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.SUPABASE_SERVICE_ROLE_KEY!,
    );

    if (t === 'bet') {
      const { data: bet } = await db
        .from('user_bets')
        .select('user_id, outcome_index, stake_tngn, payout_tngn, locked_odds, markets:market_id (question, options)')
        .eq('id', id)
        .maybeSingle();
      if (!bet) return null;
      const { data: owner } = await db
        .from('users')
        .select('username, first_name')
        .eq('id', bet.user_id)
        .maybeSingle();
      const m: any = (bet as any).markets || {};
      const opts: string[] = Array.isArray(m.options) ? m.options : [];
      const stake = Number(bet.stake_tngn || 0);
      const locked = bet.locked_odds == null ? null : Number(bet.locked_odds);
      const payout = bet.payout_tngn != null
        ? Number(bet.payout_tngn)
        : locked ? Math.round(stake * locked) : stake;
      return {
        type: 'bet',
        id,
        ownerHandle: ((owner?.username || owner?.first_name || 'predictor') as string).replace(/\s+/g, '').slice(0, 18),
        marketQuestion: String(m.question || '').replace(/\[.*?\]\s*/g, '').trim(),
        pickLabel: opts[bet.outcome_index] ?? `option ${bet.outcome_index}`,
        oddsLabel: locked ? `${locked.toFixed(2)}×` : '—',
        stakeTngn: stake,
        payoutTngn: payout,
      };
    }

    const { data: slip } = await db
      .from('multiplier_slips')
      .select('user_id, slip_stake_tngn, combined_odds, payout_tngn, legs_total')
      .eq('id', id)
      .maybeSingle();
    if (!slip) return null;
    const { data: owner } = await db
      .from('users')
      .select('username, first_name')
      .eq('id', (slip as any).user_id)
      .maybeSingle();
    return {
      type: 'slip',
      id,
      ownerHandle: ((owner?.username || owner?.first_name || 'predictor') as string).replace(/\s+/g, '').slice(0, 18),
      marketQuestion: `${Number((slip as any).legs_total || 0)}-leg Multiplier`,
      pickLabel: `${Number((slip as any).legs_total || 0)} legs`,
      oddsLabel: `${Number((slip as any).combined_odds || 0).toFixed(2)}×`,
      stakeTngn: Number((slip as any).slip_stake_tngn || 0),
      payoutTngn: Number((slip as any).payout_tngn || 0),
    };
  } catch {
    return null;
  }
}

export async function generateMetadata(
  { params, searchParams }: { params: { type: string; id: string }; searchParams?: { theme?: string } },
): Promise<Metadata> {
  const info = await loadInitial(params.type, params.id);
  const theme = (searchParams?.theme || '').toString();
  const themeQ = theme ? `?theme=${encodeURIComponent(theme)}` : '';
  const cardUrl = `${SITE}/api/picks-card/${params.type}/${params.id}${themeQ}`;

  const title = info
    ? `@${info.ownerHandle}'s OPx Pick — ₦${Math.round(info.stakeTngn).toLocaleString()} → ₦${Math.round(info.payoutTngn).toLocaleString()}`
    : 'OPx Picks — Opinions.ng';
  const description = info
    ? `${info.marketQuestion} · Pick: ${info.pickLabel} · ${info.oddsLabel}. Stake the same call, or make it yours.`
    : "Predict and win on Nigeria's prediction market.";

  return {
    title,
    description,
    openGraph: {
      title,
      description,
      url: `${SITE}/p/${params.type}/${params.id}${themeQ}`,
      images: [{ url: cardUrl, width: 1080, height: 1350 }],
    },
    twitter: {
      card: 'summary_large_image',
      title,
      description,
      images: [cardUrl],
    },
  };
}

export default async function PicksLandingPage(
  { params, searchParams }: { params: { type: string; id: string }; searchParams?: { theme?: string } },
) {
  const t = (params.type || '').toLowerCase();
  if (t !== 'bet' && t !== 'slip') notFound();
  return (
    <PicksLandingClient
      type={t as 'bet' | 'slip'}
      id={params.id}
      initialTheme={(searchParams?.theme || null) as string | null}
    />
  );
}

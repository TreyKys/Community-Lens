import type { Metadata } from 'next';
import { createClient } from '@supabase/supabase-js';
import Link from 'next/link';

// Public share landing page. A user shares opinionsng.com/u/<id>; the link
// unfurls into their accuracy card (via the OG image below), and anyone who
// taps it lands here — a credibility flex plus a single CTA into the funnel.
// No auth: this is the top of the acquisition funnel, deliberately public
// and exposing only vanity stats.

export const revalidate = 300;

const SITE = 'https://opinionsng.com';

async function loadStats(userId: string) {
  try {
    const db = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.SUPABASE_SERVICE_ROLE_KEY!,
    );
    const { data: user } = await db
      .from('users')
      .select('username, first_name')
      .eq('id', userId)
      .maybeSingle();
    if (!user) return null;

    const { data: bets } = await db
      .from('user_bets')
      .select('status')
      .eq('user_id', userId);
    const won = (bets || []).filter(b => b.status === 'won').length;
    const lost = (bets || []).filter(b => b.status === 'lost').length;
    const resolved = won + lost;
    return {
      handle: (user.username || user.first_name || 'predictor').replace(/\s+/g, '').slice(0, 18),
      accuracy: resolved > 0 ? Math.round((won / resolved) * 100) : 0,
      won,
      resolved,
    };
  } catch {
    return null;
  }
}

export async function generateMetadata({ params }: { params: { userId: string } }): Promise<Metadata> {
  const stats = await loadStats(params.userId);
  const cardUrl = `${SITE}/api/card/${params.userId}`;
  const title = stats
    ? `@${stats.handle} — ${stats.accuracy}% forecast accuracy`
    : 'Forecast accuracy — Opinions.ng';
  const description = stats
    ? `${stats.won} correct out of ${stats.resolved} resolved predictions on Opinions.ng. Think you can call it better?`
    : "Nigeria's event-prediction market. Take a position.";

  return {
    title,
    description,
    openGraph: {
      title,
      description,
      url: `${SITE}/u/${params.userId}`,
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

export default async function ShareCardPage({ params }: { params: { userId: string } }) {
  const stats = await loadStats(params.userId);
  const cardUrl = `/api/card/${params.userId}`;

  return (
    <div className="relative min-h-screen flex items-center justify-center p-4">
      <div className="fixed inset-0 z-0 pointer-events-none opacity-40">
        <div className="absolute top-0 left-1/2 -translate-x-1/2 w-[600px] h-[600px] rounded-full bg-emerald-500/15 blur-[150px]" />
      </div>

      <div className="relative z-10 w-full max-w-md space-y-6 text-center py-10">
        {/* The card itself, rendered as an image so it matches exactly what
            got shared. object-contain keeps the 1080×1350 aspect intact. */}
        <img
          src={cardUrl}
          alt={stats ? `@${stats.handle} accuracy card` : 'Accuracy card'}
          className="w-full rounded-2xl border border-emerald-500/20 shadow-2xl"
        />

        <div className="space-y-2">
          <h1 className="text-2xl font-bold tracking-tight">
            {stats ? `@${stats.handle} is calling it on Opinions.ng` : 'Opinions.ng'}
          </h1>
          <p className="text-sm text-muted-foreground">
            Nigeria&rsquo;s event-prediction market. Football, politics, pop culture, the economy —
            take a position and get paid for being right.
          </p>
        </div>

        <Link
          href="/?utm_source=accuracy_card&utm_medium=share"
          className="inline-flex items-center justify-center w-full h-12 rounded-xl bg-emerald-500 hover:bg-emerald-400 text-black font-semibold transition-colors"
        >
          Make your first prediction →
        </Link>
      </div>
    </div>
  );
}

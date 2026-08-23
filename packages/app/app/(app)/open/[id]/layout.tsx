import type { Metadata } from 'next';
import { createClient } from '@supabase/supabase-js';

// Link metadata for a market page.
//
// The page itself is a client component (it has a live order ticket), and a
// client component cannot export generateMetadata — so the unfurl data lives
// in this layout, which renders on the server and wraps it.
//
// This is what makes "share and earn" work at all. In Nigeria a market spreads
// by being pasted into a WhatsApp group, and a link that previews as a bare
// domain does not get opened.

const SITE = process.env.NEXT_PUBLIC_APP_URL || 'https://opinionsng.com';

const supabaseAdmin = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
);

export async function generateMetadata(
  { params }: { params: { id: string } },
): Promise<Metadata> {
  const fallback: Metadata = {
    title: 'Trading · Opinions.ng',
    description: 'Real predictions, real money.',
  };

  try {
    const { data: m } = await supabaseAdmin
      .from('open_markets')
      .select('question, description, status')
      .eq('id', params.id)
      .maybeSingle();

    // An unapproved market must not be discoverable, and an unfurled preview
    // in a group chat is exactly discovery.
    if (!m || ['pending_review', 'revise', 'rejected'].includes((m as any).status)) {
      return fallback;
    }

    const question = String((m as any).question);
    const description = String((m as any).description || '')
      || 'Buy a side. Sell any time — you don’t have to wait for the answer.';
    const image = `${SITE}/api/open-card/${params.id}`;

    return {
      title: `${question} · Opinions.ng`,
      description,
      openGraph: {
        title: question,
        description,
        url: `${SITE}/open/${params.id}`,
        siteName: 'Opinions.ng',
        images: [{ url: image, width: 1200, height: 675 }],
        type: 'website',
      },
      twitter: {
        card: 'summary_large_image',
        title: question,
        description,
        images: [image],
      },
    };
  } catch {
    // Never let a metadata lookup take the page down — the market still loads.
    return fallback;
  }
}

export default function OpenMarketLayout({ children }: { children: React.ReactNode }) {
  return <>{children}</>;
}

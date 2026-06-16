import type { MetadataRoute } from 'next';
import { createClient } from '@supabase/supabase-js';

// Public URL inventory fed to search engines. Next.js compiles this
// into /sitemap.xml at request time. Cached 1h so Google's daily
// recrawl doesn't run a fresh Supabase query on every fetch.
const SITE_URL = 'https://opinionsng.com';

export const revalidate = 3600;

export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  // Static routes always present. Priority 1.0 is for the home page;
  // changeFrequency is a hint to crawlers, not a guarantee.
  const staticRoutes: MetadataRoute.Sitemap = [
    { url: `${SITE_URL}/`,             changeFrequency: 'daily',   priority: 1.0 },
    { url: `${SITE_URL}/markets`,      changeFrequency: 'hourly',  priority: 0.9 },
    { url: `${SITE_URL}/leaderboard`,  changeFrequency: 'daily',   priority: 0.7 },
    { url: `${SITE_URL}/terms`,        changeFrequency: 'monthly', priority: 0.3 },
    { url: `${SITE_URL}/privacy`,      changeFrequency: 'monthly', priority: 0.3 },
  ];

  // Dynamic event pages. Wrap the Supabase call so a transient DB
  // failure can't take the whole sitemap offline — crawlers will still
  // get the static routes and try again on the next revalidate window.
  try {
    const supabase = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.SUPABASE_SERVICE_ROLE_KEY!
    );

    // Top-level markets only — sub-markets share the parent event page,
    // so listing them separately would create duplicate-content
    // signals. Voided markets are excluded; their pages render an
    // empty state that's noise to indexers.
    const { data: markets } = await supabase
      .from('markets')
      .select('id, status, updated_at, created_at')
      .in('status', ['open', 'locked', 'resolved'])
      .is('parent_market_id', null)
      .order('created_at', { ascending: false })
      .limit(1000);

    const dynamicRoutes: MetadataRoute.Sitemap = (markets || []).map((m) => ({
      url: `${SITE_URL}/event/${m.id}`,
      lastModified: m.updated_at || m.created_at || undefined,
      changeFrequency: m.status === 'open' ? 'hourly' : 'weekly',
      priority: m.status === 'open' ? 0.8 : 0.5,
    }));

    return [...staticRoutes, ...dynamicRoutes];
  } catch {
    return staticRoutes;
  }
}

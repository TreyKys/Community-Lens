import type { MetadataRoute } from 'next';

// Tells search engine crawlers which paths they can fetch. The Sitemap
// pointer at the bottom tells them where to find our full URL list so
// they don't have to discover everything by following internal links.
//
// Important: robots.txt is a *polite* request, not a security control.
// Disallows here exist to (a) stop Google wasting its crawl budget on
// junk routes and (b) keep transient URLs with sensitive query strings
// (payment callbacks with refs / tokens) out of the public index.
const SITE_URL = 'https://opinionsng.com';

export default function robots(): MetadataRoute.Robots {
  return {
    rules: [
      {
        userAgent: '*',
        allow: '/',
        disallow: [
          // Internal API surface — never has SEO value.
          '/api/',
          // Admin console — private, must never be indexed.
          '/admin',
          '/admin/',
          // Payment callback URLs carry transient references in the
          // query string; if Google indexes one, it's stuck there for
          // years even after the ref is consumed.
          '/wallet/squad-callback',
          '/wallet/paystack-callback',
          // User-specific page — public would be confusing to indexers
          // (everyone sees their own data via auth, no canonical view).
          '/profile',
        ],
      },
    ],
    sitemap: `${SITE_URL}/sitemap.xml`,
    host: SITE_URL,
  };
}

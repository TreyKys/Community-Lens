import type { MetadataRoute } from 'next';

// Web app manifest.
//
// Added for push, not for vanity. On Android the manifest is optional for push
// but decides whether the app can be installed at all; on iOS it is MANDATORY
// — Safari only grants push permission to a site that has been added to the
// Home Screen, and it will only offer that for a site with a valid manifest
// and a display mode of standalone. Without this file iOS users simply cannot
// receive notifications and there is no error to tell anyone why.

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: 'Opinions.ng — Nigeria’s Event-Prediction Market',
    short_name: 'Opinions.ng',
    description:
      'Predict football, politics, pop culture and the economy. Instant Naira settlement.',
    start_url: '/markets',
    // Landing on /markets rather than / because someone who installed the app
    // has already been sold; the marketing page is not what they opened it for.
    scope: '/',
    display: 'standalone',
    orientation: 'portrait',
    background_color: '#050A08',
    theme_color: '#050A08',
    categories: ['sports', 'finance', 'entertainment'],
    icons: [
      { src: '/icons/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
      { src: '/icons/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
      // Android crops icons to whatever shape the launcher uses. The maskable
      // variant keeps the mark inside the safe zone so it is not shaved off.
      { src: '/icons/icon-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
    ],
    shortcuts: [
      { name: 'Markets', url: '/markets' },
      { name: 'My bets', url: '/bets' },
      { name: 'Wallet', url: '/dashboard' },
    ],
  };
}

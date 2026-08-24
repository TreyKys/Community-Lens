// What's New — the release note users actually see.
//
// Bump RELEASE when there is something worth interrupting someone for. The
// version is the localStorage key, so bumping it re-shows the modal once per
// person and never again.
//
// Keep the list SHORT. A modal listing nine things is a changelog, and nobody
// reads a changelog — the point is that a returning user learns the two or
// three things that change what they can do today.

export const WHATS_NEW_RELEASE = '2026-08-v1';

export type WhatsNewItem = {
  emoji: string;
  title: string;
  body: string;
  href?: string;
  cta?: string;
};

export const WHATS_NEW: WhatsNewItem[] = [
  {
    emoji: '📈',
    title: 'Buy and sell, not just bet',
    body: 'Trading moves with the crowd. Buy a side and sell any time — you don’t have to wait for the answer.',
    href: '/open',
    cta: 'Try it',
  },
  {
    emoji: '✍️',
    title: 'Make your own market',
    body: 'Ask a question people will argue about. If it gets busy, you earn 25% of the fees it makes.',
    href: '/open/create',
    cta: 'Create one',
  },
  {
    emoji: '👁️',
    title: 'Big Brother Naija has its own home',
    body: 'Plus Basketball, Tennis, Esports and Boxing — every one with its own page.',
    href: '/bbn',
    cta: 'Open BBN',
  },
  {
    emoji: '🔥',
    title: 'Streaks pay you',
    body: 'Show up seven days running for ₦200. Stake seven days running for ₦500. Four more to collect.',
    href: '/dashboard',
    cta: 'See streaks',
  },
  {
    // Referrals are not new — they have been here all along and most people
    // never noticed, which from the user's side is the same problem. Merged
    // with the profile bonuses rather than listed separately: they are one
    // thought ("there is money sitting there"), and two rows for one thought
    // is how a five-item list turns into a changelog.
    emoji: '🎁',
    title: 'Free bonus, right now',
    body: 'Add your number and follow us for up to ₦600. Your invite link pays ₦200 a head on top — ₦200 to your friend too.',
    href: '/dashboard#invite',
    cta: 'Claim it',
  },
  {
    emoji: '🔔',
    title: 'We can tell you when you win',
    body: 'Turn on notifications and the result reaches your phone instead of waiting for you to check.',
    href: '/profile',
    cta: 'Turn on',
  },
];

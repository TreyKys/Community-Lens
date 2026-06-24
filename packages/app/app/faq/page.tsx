import type { Metadata } from 'next';
import Link from 'next/link';
import { HelpCircle } from 'lucide-react';

// /faq — public, SEO-friendly. Native <details> accordions (no client JS)
// plus FAQPage JSON-LD so Google can render rich FAQ results for branded
// and how-to queries ("how do I withdraw from opinions.ng", "what is a
// Multiplier on opinions ng", etc.).

export const metadata: Metadata = {
  title: 'FAQ · Opinions.ng',
  description:
    'How Opinions.ng works — predictions, locked odds, Multipliers, Boosts, deposits, withdrawals, the leaderboard, and account safety. Plain answers.',
  alternates: { canonical: '/faq' },
};

// Single source of truth for the FAQ content — rendered to the page AND
// serialised into the JSON-LD below so they never drift.
const FAQS: { q: string; a: string }[] = [
  {
    q: 'What is Opinions.ng?',
    a: "Opinions.ng is Nigeria's event-prediction market. You commit naira to forecast the outcome of real events — football, politics, pop culture, the economy, crypto — and get paid when you're right. It's prediction, not a slot machine: your edge is being a better forecaster than the crowd.",
  },
  {
    q: 'Is Opinions.ng legit and safe?',
    a: 'We are operated by NeuroDev Labs Technologies, a registered Nigerian business (CAC RC 9430461). Deposits are processed by Squad (HabariPay), a CBN-licensed processor. Market predictions are sealed cryptographically on Polygon so resolution can be independently verified. Full details, including who runs the platform and where your money sits, are on our Trust page.',
  },
  {
    q: 'How do predictions work?',
    a: "Pick an outcome, choose your stake, and confirm. On most markets your odds lock at the moment you stake — the rate you see is the rate you're paid if you're right. The amount shown is a guaranteed floor that can grow as more people predict the other way; you'll never be paid less than the floor we showed you.",
  },
  {
    q: 'What is a Multiplier?',
    a: "A Multiplier is a single ticket combining 2–10 predictions across different markets. Every pick must be right to win, but the odds multiply together — small stakes can return big. You need a Boost to place one. If a leg's match is postponed or voided, that leg becomes neutral (1.0×) and the rest of your ticket still runs; if every leg is voided, your stake and Boost are refunded.",
  },
  {
    q: 'How many markets can one Multiplier have?',
    a: 'Up to 5 markets if your stake is under ₦500, and up to 10 markets if your stake is ₦500 or more. Each pick must be from a different event, with combined odds of at least 3.0×.',
  },
  {
    q: 'What are Boosts?',
    a: 'A Boost is the ticket that lets you place one Multiplier. You get 5 free when you join and earn more over time, and you can buy extra Boosts at the price shown in the app. Singles (normal predictions) never need a Boost — Boosts are only for Multipliers.',
  },
  {
    q: 'How do deposits and withdrawals work?',
    a: 'Deposit by card, bank transfer or USSD through Squad — minimum ₦500, credited after confirmation. Withdraw to any Nigerian bank account, minimum ₦200, reviewed and paid within 24 hours (usually much faster). A small conversion spread applies, shown before you confirm.',
  },
  {
    q: 'What is the leaderboard?',
    a: 'The leaderboard ranks predictors by points earned from predicting and winning. There are Daily, Weekly and All-Time boards. Top finishers each week share a cash-and-credit prize pool. Your accuracy — how often your resolved predictions are correct — is shown alongside your rank.',
  },
  {
    q: 'How is my accuracy calculated?',
    a: 'Accuracy is the share of your resolved predictions that turned out correct. It updates every time one of your markets settles and is shown on your profile and on the leaderboard.',
  },
  {
    q: 'Do I need to verify my identity (KYC)?',
    a: 'You sign in with your phone number. We may ask you to confirm your identity before processing large withdrawals, both to protect you and to meet our compliance obligations. You must be 18 or older to use Opinions.ng.',
  },
  {
    q: 'What happens if a market can’t be resolved fairly?',
    a: 'If an event is cancelled, a result is genuinely ambiguous, or our data source fails, we void the market and refund the affected predictions. We resolve against the source of truth named on each market page, and resolution is final after the dispute window.',
  },
  {
    q: 'How do I get help?',
    a: 'Email opng@neurodevlabs.cloud or hello@neurodevlabs.cloud — we typically respond within 24 hours, faster during Lagos business hours.',
  },
];

export default function FaqPage() {
  const jsonLd = {
    '@context': 'https://schema.org',
    '@type': 'FAQPage',
    mainEntity: FAQS.map(({ q, a }) => ({
      '@type': 'Question',
      name: q,
      acceptedAnswer: { '@type': 'Answer', text: a },
    })),
  };

  return (
    <article className="max-w-3xl mx-auto px-4 py-10 md:py-16">
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd) }}
      />

      <header className="mb-8 border-b border-emerald-500/15 pb-6">
        <div className="flex items-center gap-2 text-xs uppercase tracking-[0.18em] text-emerald-400 font-semibold mb-2">
          <HelpCircle className="w-3 h-3" /> Help
        </div>
        <h1 className="text-3xl md:text-4xl font-extrabold tracking-tight">Frequently asked questions</h1>
        <p className="text-muted-foreground text-sm mt-3 leading-relaxed">
          Everything you need to know about predicting on Opinions.ng. Still stuck? Email{' '}
          <a href="mailto:opng@neurodevlabs.cloud" className="text-emerald-400 hover:text-emerald-300 underline underline-offset-2">opng@neurodevlabs.cloud</a>.
        </p>
      </header>

      <div className="space-y-2">
        {FAQS.map(({ q, a }, i) => (
          <details
            key={i}
            className="group rounded-xl border border-border/40 bg-card/40 px-4 py-3 [&_summary]:cursor-pointer"
          >
            <summary className="flex items-center justify-between gap-3 list-none font-medium text-sm">
              {q}
              <span className="shrink-0 text-muted-foreground transition-transform group-open:rotate-45 text-lg leading-none">+</span>
            </summary>
            <p className="mt-2.5 text-sm text-muted-foreground leading-relaxed">{a}</p>
          </details>
        ))}
      </div>

      <footer className="mt-10 pt-6 border-t border-emerald-500/10 text-xs text-muted-foreground">
        See also our{' '}
        <Link href="/trust" className="text-emerald-400 hover:text-emerald-300 underline underline-offset-2">Trust &amp; Identity</Link>,{' '}
        <Link href="/terms" className="text-emerald-400 hover:text-emerald-300 underline underline-offset-2">Terms</Link> and{' '}
        <Link href="/privacy" className="text-emerald-400 hover:text-emerald-300 underline underline-offset-2">Privacy Policy</Link>.
        18+. Predict responsibly.
      </footer>
    </article>
  );
}

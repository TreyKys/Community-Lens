import type { Metadata } from 'next';
import Link from 'next/link';
import {
  Shield, Building2, Banknote, Link2, ArrowDownToLine, Mail,
  Globe, Github, CheckCircle2,
} from 'lucide-react';

// /trust — the destination every external trust signal points back to.
// Crunchbase, LinkedIn, Nairaland, Trustpilot, X, IG, press articles
// should all link here. Answers the literal question a Nigerian skeptic
// runs Googling "Opinions.ng legit?" — who runs it, where the money
// sits, how resolution works, who to email when something breaks.
//
// PUBLIC ROUTE, NOT INSIDE (app). Lives in the sitemap (handled by
// app/sitemap.ts adding it explicitly is a follow-up if we want
// dedicated priority).

export const metadata: Metadata = {
  title: 'Trust & Identity · Opinions.ng',
  description:
    "Who runs Opinions.ng, where your money sits, how resolution works, and how to reach us. NeuroDev Labs Technologies — CAC RC 9430461.",
  alternates: { canonical: '/trust' },
};

// ── EDIT ME: identity + external profile URLs ────────────────────────
// Keep them at the top so they're easy to find. Profile URLs default to
// null while the profile is in flight; the ExternalProfileCard renders
// a dim "Soon" tile in that case so the grid stays balanced.
const TRUST = {
  cac:        '9430461',         // CAC Business Name (already on /terms)
  duns:       '669827712',       // NeuroDev Labs D-U-N-S Number
  officeAddr: 'Lagos, Nigeria',  // city only — no street address by choice
  contractAddress: 'TBD — 0x… (TruthMarket.sol on Polygon)',
  polygonscanUrl:  'https://polygonscan.com',
  profiles: {
    x:           'https://x.com/opinions_ng',
    instagram:   'https://www.instagram.com/opinionshq_ng',
    crunchbase:  null as string | null,
    linkedin:    null as string | null,            // Company Page
    nairaland:   null as string | null,
    github:      null as string | null,
    polygonscan: null as string | null,            // verified contract page
  },
} as const;

export default function TrustPage() {
  return (
    <article className="max-w-3xl mx-auto px-4 py-10 md:py-16">
      <header className="mb-10 border-b border-emerald-500/15 pb-6">
        <div className="flex items-center gap-2 text-xs uppercase tracking-[0.18em] text-emerald-400 font-semibold mb-2">
          <Shield className="w-3 h-3" /> Trust &amp; Identity
        </div>
        <h1 className="text-3xl md:text-4xl font-extrabold tracking-tight">
          Who we are. Where your money sits. How we settle.
        </h1>
        <p className="text-muted-foreground text-sm mt-3 leading-relaxed">
          New platforms deserve scrutiny. Below is every detail a careful Nigerian would want before
          they deposit a single naira on Opinions.ng — laid out plain, with the receipts.
        </p>
      </header>

      <div className="space-y-10">

        {/* ── Who runs this ───────────────────────────────────────── */}
        <Section icon={Building2} title="Who runs Opinions.ng">
          <p>
            Opinions.ng is operated by <strong>NeuroDev Labs Technologies</strong>, a business
            registered in the Federal Republic of Nigeria.
          </p>
          <KeyValue>
            <Row k="Legal entity"  v="NeuroDev Labs Technologies" />
            <Row k="CAC RC Number" v={TRUST.cac} mono />
            <Row k="D-U-N-S Number" v={TRUST.duns} mono />
            <Row k="Registered address" v={TRUST.officeAddr} />
          </KeyValue>
          <p className="text-xs text-muted-foreground">
            NeuroDev Labs Technologies is a regulated business operating under Nigerian law.
            If anything you read on this page turns out to be wrong, write to us and we&rsquo;ll correct it.
          </p>
        </Section>

        {/* ── Where the money sits ───────────────────────────────── */}
        <Section icon={Banknote} title="Where your money actually sits">
          <p>
            Deposits do not go into our personal account. They are processed by{' '}
            <strong>Squad (HabariPay)</strong>, a CBN-licensed Nigerian payment processor and a
            subsidiary of GTCO. Squad is a real, regulated company — not us pretending to be a bank.
          </p>
          <ul className="space-y-2 text-sm">
            <li className="flex gap-2"><CheckCircle2 className="w-4 h-4 text-emerald-400 mt-0.5 shrink-0" />
              When you deposit, Squad mints a one-time virtual NUBAN for your transfer.
              The naira lands in Squad&rsquo;s books first; we credit your tNGN balance only after
              their webhook confirms receipt.
            </li>
            <li className="flex gap-2"><CheckCircle2 className="w-4 h-4 text-emerald-400 mt-0.5 shrink-0" />
              When you withdraw, the bank transfer is paid out of Squad&rsquo;s rails to your
              own bank account, after admin review.
            </li>
            <li className="flex gap-2"><CheckCircle2 className="w-4 h-4 text-emerald-400 mt-0.5 shrink-0" />
              We charge a 1% conversion spread on deposits and 1% + ₦50 on withdrawals.
              No hidden fees, no surprise deductions. The arithmetic is visible at every step.
            </li>
          </ul>
          <p className="text-xs text-muted-foreground">
            The escape-hatch clause in our{' '}
            <Link href="/terms" className="text-emerald-400 hover:text-emerald-300 underline underline-offset-2">Terms</Link>{' '}
            guarantees you a route to your balance even in the extreme case that we go dark
            for 30 days. You are never locked out of your own funds.
          </p>
        </Section>

        {/* ── How resolution works ───────────────────────────────── */}
        <Section icon={Link2} title="How resolution works (and why we can't fix it)">
          <p>
            Opinions.ng is a <strong>parimutuel prediction market</strong>. Players&rsquo; stakes
            pay players&rsquo; winnings. We&rsquo;re the bookkeeper, not the house — we cannot
            &ldquo;decide&rdquo; an outcome to suit ourselves, because we&rsquo;re not on a side.
          </p>
          <p>
            When a market locks (no more new stakes), we publish a{' '}
            <strong>Merkle root</strong> of the prediction ledger on <strong>Polygon</strong>.
            The root is a one-way cryptographic fingerprint of every prediction in the market —
            the exact stakes, outcomes and users at lock time. Any change to the underlying
            data after that moment produces a different fingerprint, so retroactive tampering is
            mathematically detectable by anyone, not just us.
          </p>
          <KeyValue>
            <Row k="Settlement chain" v="Polygon mainnet" />
            <Row k="Contract address" v={TRUST.contractAddress} mono />
            <Row k="Verified source"  v={
              <a className="text-emerald-400 hover:text-emerald-300 underline underline-offset-2" href={TRUST.polygonscanUrl} target="_blank" rel="noopener noreferrer">
                View on Polygonscan →
              </a>
            } />
          </KeyValue>
          <p className="text-xs text-muted-foreground">
            Resolution itself is published the same way. The outcome, the timestamp, and who paid
            what to whom are all in the ledger that the on-chain root commits to. Your bet receipt
            in <Link href="/bets" className="text-emerald-400 hover:text-emerald-300 underline underline-offset-2">/bets</Link> includes a
            Merkle proof you can verify yourself.
          </p>
        </Section>

        {/* ── Withdrawals ────────────────────────────────────────── */}
        <Section icon={ArrowDownToLine} title="Withdrawal SLA — what to expect">
          <ul className="space-y-2 text-sm">
            <li className="flex gap-2"><CheckCircle2 className="w-4 h-4 text-emerald-400 mt-0.5 shrink-0" />
              <span><strong>Standard withdrawals:</strong> reviewed and paid within 24 hours.
              Most go through within a few hours during business time.</span>
            </li>
            <li className="flex gap-2"><CheckCircle2 className="w-4 h-4 text-emerald-400 mt-0.5 shrink-0" />
              <span><strong>Large withdrawals (₦500,000+):</strong> an additional manual security review.
              Up to 24 hours. We&rsquo;ll email you if anything looks unusual.</span>
            </li>
            <li className="flex gap-2"><CheckCircle2 className="w-4 h-4 text-emerald-400 mt-0.5 shrink-0" />
              <span><strong>Bank verification:</strong> we check the account name against your
              NUBAN before sending. Withdrawals to the wrong account cannot be reversed — for your
              protection, get the details right.</span>
            </li>
            <li className="flex gap-2"><CheckCircle2 className="w-4 h-4 text-emerald-400 mt-0.5 shrink-0" />
              <span><strong>If we go silent for 30 days:</strong> the escape-hatch contract on Polygon
              opens up. You can withdraw your balance directly. Full mechanics in our{' '}
              <Link href="/terms" className="text-emerald-400 hover:text-emerald-300 underline underline-offset-2">Terms</Link>.
              </span>
            </li>
          </ul>
        </Section>

        {/* ── Contact ─────────────────────────────────────────────── */}
        <Section icon={Mail} title="How to reach us — directly">
          <p>
            We answer email. Nothing fancy. The fastest route to a human:
          </p>
          <KeyValue>
            <Row k="Support" v={<a className="text-emerald-400 hover:text-emerald-300 underline underline-offset-2" href="mailto:opng@neurodevlabs.cloud">opng@neurodevlabs.cloud</a>} />
            <Row k="Operations" v={<a className="text-emerald-400 hover:text-emerald-300 underline underline-offset-2" href="mailto:hello@neurodevlabs.cloud">hello@neurodevlabs.cloud</a>} />
            <Row k="Typical response" v="Within 24 hours, faster during Lagos business hours" />
          </KeyValue>
        </Section>

        {/* ── External profiles ──────────────────────────────────── */}
        <Section icon={Globe} title="Where else we live online">
          <p className="text-sm">
            Don&rsquo;t take our word for it — verify us across the platforms diligent users
            actually trust. Profiles populate as they go live; if a link below 404s, it&rsquo;s
            because we haven&rsquo;t shipped that profile yet, not because it&rsquo;s gone.
          </p>
          <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
            <ExternalProfileCard label="X (Twitter)"      href={TRUST.profiles.x} />
            <ExternalProfileCard label="Instagram"        href={TRUST.profiles.instagram} />
            <ExternalProfileCard label="Crunchbase"       href={TRUST.profiles.crunchbase} />
            <ExternalProfileCard label="LinkedIn" href={TRUST.profiles.linkedin} />
            <ExternalProfileCard label="Nairaland Thread" href={TRUST.profiles.nairaland} />
            <ExternalProfileCard label="GitHub" href={TRUST.profiles.github} icon={Github} />
            <ExternalProfileCard label="Polygonscan (Verified Contract)" href={TRUST.profiles.polygonscan} />
          </div>
        </Section>

        {/* ── Real talk ──────────────────────────────────────────── */}
        <Section icon={Shield} title="Real talk: what we are and aren't">
          <p>
            We&rsquo;re new. We&rsquo;re small. Here&rsquo;s what that honestly means for you.
          </p>
          <ul className="space-y-2 text-sm">
            <li className="flex gap-2"><span className="text-emerald-400 font-semibold mt-0.5">·</span>
              Opinions.ng is an event-prediction information market — players forecast public
              outcomes, not a sportsbook.
            </li>
            <li className="flex gap-2"><span className="text-emerald-400 font-semibold mt-0.5">·</span>
              We are 18+ only. If you cannot afford to lose your stake, do not place one.
            </li>
            <li className="flex gap-2"><span className="text-emerald-400 font-semibold mt-0.5">·</span>
              Withdrawals are reviewed by a human before paying out. That&rsquo;s deliberate — it
              keeps the platform clean from fraud. It also means we will sometimes ask you to
              confirm your identity before processing a large withdrawal.
            </li>
            <li className="flex gap-2"><span className="text-emerald-400 font-semibold mt-0.5">·</span>
              We don&rsquo;t make wild promises about returns. The maths is parimutuel.
              You compete against other predictors for a share of the pool. The pool can be
              small. We show you the projected return before you stake.
            </li>
            <li className="flex gap-2"><span className="text-emerald-400 font-semibold mt-0.5">·</span>
              If something on this page is inaccurate, write to us. We&rsquo;ll fix it.
            </li>
          </ul>
        </Section>

      </div>

      <footer className="mt-12 pt-6 border-t border-emerald-500/10 text-xs text-muted-foreground">
        Last reviewed by NeuroDev Labs: {new Date().getFullYear()}. Read alongside our{' '}
        <Link href="/terms" className="text-emerald-400 hover:text-emerald-300 underline underline-offset-2">Terms</Link>,{' '}
        <Link href="/privacy" className="text-emerald-400 hover:text-emerald-300 underline underline-offset-2">Privacy</Link>,
        and the on-chain settlement contract above.
      </footer>
    </article>
  );
}

// ── Local helpers ────────────────────────────────────────────────────

function Section({
  icon: Icon, title, children,
}: { icon: any; title: string; children: React.ReactNode }) {
  return (
    <section className="space-y-3">
      <h2 className="flex items-center gap-2 text-base font-semibold tracking-tight">
        <Icon className="w-4 h-4 text-emerald-400" />
        {title}
      </h2>
      <div className="space-y-3 text-sm leading-relaxed text-foreground/85">
        {children}
      </div>
    </section>
  );
}

function KeyValue({ children }: { children: React.ReactNode }) {
  return (
    <div className="divide-y divide-border/40 border border-border/40 rounded-xl bg-card/40 text-sm overflow-hidden">
      {children}
    </div>
  );
}

function Row({ k, v, mono = false }: { k: string; v: React.ReactNode; mono?: boolean }) {
  return (
    <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-1 px-4 py-3">
      <span className="text-xs uppercase tracking-wider text-muted-foreground font-semibold">{k}</span>
      <span className={mono ? 'font-mono text-foreground' : 'text-foreground'}>{v}</span>
    </div>
  );
}

function ExternalProfileCard({
  label, href, icon: Icon,
}: { label: string; href: string | null; icon?: any }) {
  // Renders a disabled/dimmed card if href is null — signals "we know
  // this should exist but haven't shipped it yet" without 404-ing.
  if (!href) {
    return (
      <div className="border border-border/40 rounded-lg px-3 py-2.5 text-xs text-muted-foreground/60 flex items-center gap-2 bg-card/20">
        {Icon ? <Icon className="w-3.5 h-3.5 shrink-0" /> : <Globe className="w-3.5 h-3.5 shrink-0" />}
        <span className="truncate">{label}</span>
        <span className="ml-auto text-[10px] text-muted-foreground/40 uppercase">Soon</span>
      </div>
    );
  }
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className="border border-emerald-500/20 hover:border-emerald-500/50 hover:bg-emerald-500/5 rounded-lg px-3 py-2.5 text-xs flex items-center gap-2 transition-colors"
    >
      {Icon ? <Icon className="w-3.5 h-3.5 shrink-0 text-emerald-400" /> : <Globe className="w-3.5 h-3.5 shrink-0 text-emerald-400" />}
      <span className="truncate">{label}</span>
    </a>
  );
}

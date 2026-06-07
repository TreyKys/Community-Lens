import { Shield } from 'lucide-react';

// Terms of Service — public route, NOT inside the (app) auth group.
// Version date matches the CURRENT_TOS_VERSION in /api/user/accept-terms.
// Update both together when these change.
export const metadata = {
  title: 'Terms of Service · Opinions.ng',
};

export default function TermsPage() {
  return (
    <article className="max-w-3xl mx-auto px-4 py-10 md:py-16 prose-invert prose">
      <header className="mb-10 border-b border-emerald-500/15 pb-6">
        <div className="flex items-center gap-2 text-xs uppercase tracking-[0.18em] text-emerald-400 font-semibold mb-2">
          <Shield className="w-3 h-3" /> Legal · Effective 2026-06-07
        </div>
        <h1 className="text-3xl md:text-4xl font-extrabold tracking-tight">Terms of Service</h1>
        <p className="text-muted-foreground text-sm mt-2">
          Welcome to Opinions.ng. By creating an account or otherwise using the platform you agree
          to the terms below. Read them carefully — they govern your relationship with us.
        </p>
      </header>

      <section className="space-y-6 text-sm leading-relaxed">
        <Section title="1. Nature of the Service">
          <p>
            Opinions.ng operates a pari-mutuel <strong>event-prediction market</strong>. Users take
            positions on the outcome of public events. We are <strong>not a sportsbook,
            casino, or licensed gaming operator</strong>. Pools are funded by users, and payouts
            are distributed pro-rata from those pools after platform fees, exactly as described
            on each market page.
          </p>
          <p>
            Each market clearly states the resolution criteria and the source of truth that
            will be used to settle it. Resolution is final.
          </p>
        </Section>

        <Section title="2. Eligibility">
          <ul className="list-disc pl-5 space-y-1">
            <li>You must be at least <strong>18 years old</strong> and legally permitted to use
              event-prediction markets in your jurisdiction.</li>
            <li>You must provide accurate information at sign-up and during KYC.</li>
            <li>One account per person. Multiple accounts are grounds for permanent suspension and
              forfeiture of balance.</li>
            <li>Employees of Opinions.ng, their immediate family members, and individuals involved
              in market resolution may not participate in those markets.</li>
          </ul>
        </Section>

        <Section title="3. Wallet, Deposits and Withdrawals">
          <p>Your account has two balances:</p>
          <ul className="list-disc pl-5 space-y-1">
            <li><strong>Actual balance (tNGN)</strong> — funded by deposits and won positions.
              Withdrawable to any Nigerian bank account once KYC is complete.</li>
            <li><strong>Bonus balance</strong> — credits awarded for sign-up, referrals,
              insurance refunds and promotional events. Bonus balance is <strong>not
              withdrawable</strong> until it is wagered through (rollover requirement).</li>
          </ul>
          <p>
            We reserve the right to delay withdrawals exceeding ₦500,000 by up to 24 hours for
            security review, and to require additional KYC for unusually large flows.
          </p>
        </Section>

        <Section title="4. Fees">
          <ul className="list-disc pl-5 space-y-1">
            <li>A small entry fee is automatically deducted from each position before it enters
              the pool.</li>
            <li>A platform fee is deducted from each pool at resolution. The remainder is
              distributed pro-rata to winning positions.</li>
            <li>Withdrawal fees are disclosed in the wallet UI at the moment of withdrawal.</li>
          </ul>
        </Section>

        <Section title="5. Market Resolution & Disputes">
          <p>
            Markets are resolved against the source of truth named on the market page. We make
            our best effort to resolve quickly and correctly. In the event of a clear oracle
            error, we may void and refund the affected market. Resolution decisions are final
            after the 48-hour dispute window has elapsed.
          </p>
        </Section>

        <Section title="6. Prohibited Conduct">
          <ul className="list-disc pl-5 space-y-1">
            <li>Manipulating, coordinating or attempting to coordinate market resolution.</li>
            <li>Using bots, scripts or automated systems without our written permission.</li>
            <li>Exploiting bugs or vulnerabilities instead of reporting them to us.</li>
            <li>Money laundering, fraud, or any unlawful activity through the platform.</li>
            <li>Creating multiple accounts to abuse referral or promotional credits.</li>
          </ul>
          <p>
            We may suspend or terminate accounts, void positions, and forfeit balances for any
            violation of these rules.
          </p>
        </Section>

        <Section title="7. Risk Disclosure">
          <p>
            Taking positions on prediction markets involves financial risk. You may lose your
            entire stake. Past results are not indicative of future outcomes. Only stake what
            you can afford to lose. If you feel your engagement is becoming compulsive, contact
            <a href="https://www.responsiblegambling.org" target="_blank" rel="noopener" className="text-emerald-400 underline ml-1">a support resource</a>.
          </p>
        </Section>

        <Section title="8. Privacy">
          <p>
            Our handling of your personal data is governed by our{' '}
            <a href="/privacy" className="text-emerald-400 underline">Privacy Policy</a>, which
            forms part of these Terms.
          </p>
        </Section>

        <Section title="9. Liability & Indemnity">
          <p>
            To the maximum extent permitted by law, Opinions.ng is provided on an &quot;as is&quot;
            basis. We make no warranty as to availability, accuracy or fitness for any
            particular purpose. Our aggregate liability to any user is capped at the amount
            that user has deposited in the prior 12 months. You agree to indemnify Opinions.ng
            against losses arising from your breach of these Terms.
          </p>
        </Section>

        <Section title="10. Changes to These Terms">
          <p>
            We may update these Terms from time to time. Material changes will be notified via
            email or in-app banner, and you will be prompted to re-accept the updated Terms on
            your next sign-in.
          </p>
        </Section>

        <Section title="11. Governing Law">
          <p>
            These Terms are governed by the laws of the Federal Republic of Nigeria. Disputes
            will be resolved in the courts of Lagos State unless required otherwise by
            applicable law.
          </p>
        </Section>

        <Section title="12. Contact">
          <p>
            Questions or disputes:{' '}
            <a href="mailto:hello@opinions.ng" className="text-emerald-400 underline">
              hello@opinions.ng
            </a>
          </p>
        </Section>
      </section>
    </article>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div>
      <h2 className="text-base font-bold tracking-tight mt-6 mb-2">{title}</h2>
      <div className="text-muted-foreground space-y-2">{children}</div>
    </div>
  );
}

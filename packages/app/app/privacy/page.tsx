import { Shield } from 'lucide-react';

export const metadata = {
  title: 'Privacy Policy · Opinions.ng',
};

export default function PrivacyPage() {
  return (
    <article className="max-w-3xl mx-auto px-4 py-10 md:py-16 prose-invert prose">
      <header className="mb-10 border-b border-emerald-500/15 pb-6">
        <div className="flex items-center gap-2 text-xs uppercase tracking-[0.18em] text-emerald-400 font-semibold mb-2">
          <Shield className="w-3 h-3" /> Legal · Effective 2026-06-24
        </div>
        <h1 className="text-3xl md:text-4xl font-extrabold tracking-tight">Privacy Policy</h1>
        <p className="text-muted-foreground text-sm mt-2">
          This policy explains what data Opinions.ng — a product operated by{' '}
          <strong>NeuroDev Labs Technologies</strong> — collects, why we collect it, how we use it,
          and the rights you have over it. It applies to all users of the platform.
        </p>
      </header>

      <section className="space-y-6 text-sm leading-relaxed">
        <Section title="1. Data We Collect">
          <ul className="list-disc pl-5 space-y-1">
            <li><strong>Account data</strong>: email, phone, display name, date of birth, and any
              KYC information we collect to comply with regulatory obligations.</li>
            <li><strong>Activity data</strong>: predictions and Multiplier tickets placed, Boost
              purchases and usage, deposits, withdrawals, referral code usage, and the resulting
              points balance, accuracy record and leaderboard standing.</li>
            <li><strong>Technical data</strong>: IP address, device + browser metadata, session
              identifiers, and crash/diagnostic logs.</li>
            <li><strong>Compliance data</strong>: T&amp;C acceptance timestamps, IP and
              user-agent at the moment of acceptance.</li>
          </ul>
        </Section>

        <Section title="2. Why We Collect It">
          <ul className="list-disc pl-5 space-y-1">
            <li>To operate your account and settle your positions.</li>
            <li>To prevent fraud, multi-accounting, and money laundering.</li>
            <li>To comply with applicable regulatory and tax-reporting obligations.</li>
            <li>To improve the product (anonymous / aggregate analytics only).</li>
            <li>To send service-related notifications (and, if you opt in, product updates).</li>
          </ul>
        </Section>

        <Section title="3. How We Share It">
          <p>
            We share personal data only with vetted service providers strictly to operate the
            service:
          </p>
          <ul className="list-disc pl-5 space-y-1">
            <li>Supabase (auth + database)</li>
            <li>Squad (payment processor)</li>
            <li>Cloudflare / Vercel (hosting + infrastructure)</li>
            <li>Polygon network (anonymised market-resolution attestations only — no PII)</li>
          </ul>
          <p>
            We do <strong>not</strong> sell your data. We do not share it with advertisers or
            data brokers.
          </p>
        </Section>

        <Section title="4. Data Retention">
          <p>
            We retain account and transaction records for the period required by applicable
            financial regulations (typically 7 years from the date of last activity). Personal
            data unrelated to financial transactions is deleted upon valid request, subject to
            our legal hold obligations.
          </p>
        </Section>

        <Section title="5. Your Rights">
          <p>You may request:</p>
          <ul className="list-disc pl-5 space-y-1">
            <li>A copy of your personal data.</li>
            <li>Correction of inaccurate data.</li>
            <li>Deletion of personal data (subject to legal hold).</li>
            <li>Restriction or objection to specific processing activities.</li>
          </ul>
          <p>
            Send requests to{' '}
            <a href="mailto:privacy@opinions.ng" className="text-emerald-400 underline">privacy@opinions.ng</a>.
            We respond within 30 days.
          </p>
        </Section>

        <Section title="6. Security">
          <p>
            We protect your data with industry-standard measures: TLS in transit, encryption at
            rest, isolated production environments, principle-of-least-privilege access for
            staff, and continuous security monitoring. No system is perfectly secure — we
            disclose verified breaches affecting you within 72 hours.
          </p>
        </Section>

        <Section title="7. Cookies">
          <p>
            We use strictly necessary cookies for authentication and session management. We do
            not use third-party advertising cookies.
          </p>
        </Section>

        <Section title="8. Children">
          <p>
            Opinions.ng is for users <strong>18 years and older</strong>. We do not knowingly
            collect data from anyone under 18. If you believe a minor has registered, contact us
            and we will delete the account immediately.
          </p>
        </Section>

        <Section title="9. Updates">
          <p>
            We may update this policy. Material changes are announced in-app, by email, and
            require re-acceptance on next sign-in.
          </p>
        </Section>

        <Section title="10. Contact">
          <p>
            Questions:{' '}
            <a href="mailto:privacy@opinions.ng" className="text-emerald-400 underline">
              privacy@opinions.ng
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

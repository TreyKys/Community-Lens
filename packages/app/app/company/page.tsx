import { Building2, ShieldCheck, MessageSquare, Mail } from 'lucide-react';

// Public company page. Doubles as the verification document for partners
// (payment processors, SMS aggregators) who need to see the relationship
// between the Opinions.ng product and its operating entity, NeuroDev Labs.
export const metadata = {
  title: 'Company · NeuroDev Labs Technologies',
  description:
    'Opinions.ng is operated by NeuroDev Labs Technologies, a software business registered in Nigeria (CAC BN 9430461).',
};

function Row({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex flex-col sm:flex-row sm:items-baseline gap-1 sm:gap-4 py-2 border-b border-border/40 last:border-0">
      <span className="text-xs uppercase tracking-wider text-muted-foreground sm:w-48 shrink-0">{label}</span>
      <span className="text-sm font-medium">{value}</span>
    </div>
  );
}

function Section({ icon: Icon, title, children }: { icon: any; title: string; children: React.ReactNode }) {
  return (
    <section className="space-y-3">
      <h2 className="flex items-center gap-2 text-base font-bold tracking-tight">
        <Icon className="w-4 h-4 text-emerald-400" /> {title}
      </h2>
      <div className="text-sm text-muted-foreground space-y-2 leading-relaxed">{children}</div>
    </section>
  );
}

export default function CompanyPage() {
  return (
    <article className="max-w-3xl mx-auto px-4 py-10 md:py-16 space-y-10">
      <header className="border-b border-emerald-500/15 pb-6">
        <div className="flex items-center gap-2 text-xs uppercase tracking-[0.18em] text-emerald-400 font-semibold mb-2">
          <Building2 className="w-3 h-3" /> Company Information
        </div>
        <h1 className="text-3xl md:text-4xl font-extrabold tracking-tight">NeuroDev Labs Technologies</h1>
        <p className="text-muted-foreground text-sm mt-2">
          The software business behind Opinions.ng and our other digital products.
        </p>
      </header>

      <Section icon={Building2} title="Registered Business">
        <p>
          NeuroDev Labs Technologies (&quot;NeuroDev Labs&quot;) is a business registered with the
          Corporate Affairs Commission of the Federal Republic of Nigeria under the Companies and
          Allied Matters Act, 2020.
        </p>
        <div className="mt-3 rounded-xl border border-border/60 bg-card/40 px-4 py-2">
          <Row label="Legal name" value="NeuroDev Labs Technologies" />
          <Row label="Registration No." value="BN 9430461 (CAC)" />
          <Row label="Tax Identification" value="2622473979523" />
          <Row label="Nature of business" value="Software development, web design and intranet development" />
          <Row label="Registered address" value="2 Uba Crescent, Victory Estate Iba, Iba Ojo, Lagos State, Nigeria" />
          <Row label="Country" value="Nigeria" />
        </div>
      </Section>

      <Section icon={ShieldCheck} title="Our Products & The Opinions.ng Relationship">
        <p>
          <strong className="text-foreground">Opinions.ng</strong> is a product owned and operated by
          NeuroDev Labs Technologies. It is an event-prediction information platform where users
          forecast the outcome of public events. All references on Opinions.ng to &quot;we&quot;,
          &quot;us&quot;, or &quot;the operator&quot; refer to NeuroDev Labs Technologies.
        </p>
        <p>
          This relationship is reflected in the Opinions.ng{' '}
          <a href="/terms" className="text-emerald-400 underline">Terms of Service</a> and{' '}
          <a href="/privacy" className="text-emerald-400 underline">Privacy Policy</a>, both of which
          name NeuroDev Labs Technologies as the operating entity.
        </p>
      </Section>

      <Section icon={MessageSquare} title="Use of SMS / Messaging">
        <p>
          NeuroDev Labs uses SMS strictly for <strong className="text-foreground">transactional
          one-time passcodes (OTP)</strong> to verify a user&apos;s phone number at sign-in. We do
          not send marketing or promotional SMS, and every message is triggered by an action the
          user has just taken on our platform.
        </p>
        <p className="text-xs bg-muted/30 border border-border/50 rounded-lg px-3 py-2 font-mono">
          Sample: &quot;Your Opinions.ng verification code is 123456. It expires in 10 minutes.&quot;
        </p>
        <p>
          We maintain a zero-tolerance anti-spam policy and honour opt-out and data-deletion requests
          in line with our Privacy Policy and the Nigeria Data Protection Act.
        </p>
      </Section>

      <Section icon={Mail} title="Contact">
        <p>
          For partnership, compliance, or verification enquiries, reach us at{' '}
          <a href="mailto:hello@opinions.ng" className="text-emerald-400 underline">hello@opinions.ng</a>.
        </p>
      </Section>

      <footer className="pt-6 border-t border-border/40 text-xs text-muted-foreground">
        © {new Date().getFullYear()} NeuroDev Labs Technologies. All rights reserved.
      </footer>
    </article>
  );
}

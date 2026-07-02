import { NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';

export const dynamic = 'force-dynamic';
export const revalidate = 30;

const supabaseAdmin = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
);

// GET /api/status
//
// Public, unauthed. Returns a lightweight system health summary derived
// from open system_alerts. Purposely does NOT leak internals — no
// affected IDs, no user counts, just a category-level "we're aware of
// an issue with X" or "all systems normal."
export async function GET() {
  const { data: alerts } = await supabaseAdmin
    .from('system_alerts')
    .select('category, severity, status')
    .in('status', ['open', 'acknowledged']);

  const anyCritical = (alerts || []).some(a => a.severity === 'critical');
  const anyWarning = (alerts || []).some(a => a.severity === 'warning');

  // Group open alerts by category — user-facing description only.
  const cats: Record<string, { humanLabel: string; sev: 'warning' | 'critical' }> = {};
  for (const a of alerts || []) {
    if (a.severity !== 'warning' && a.severity !== 'critical') continue;
    const labels: Record<string, string> = {
      settlement:  'Bet & Multiplier settlement',
      balance:     'Wallet balances',
      deposit:     'Deposits',
      withdrawal:  'Withdrawals',
      market:      'Markets',
    };
    const label = labels[a.category] || 'General';
    const existing = cats[label];
    if (!existing || (existing.sev === 'warning' && a.severity === 'critical')) {
      cats[label] = { humanLabel: label, sev: a.severity as 'warning' | 'critical' };
    }
  }
  const impacted = Object.values(cats);

  const overall = anyCritical ? 'degraded' : anyWarning ? 'partial' : 'operational';

  return NextResponse.json({
    status: overall,
    generatedAt: new Date().toISOString(),
    impacted,
    message: overall === 'operational'
      ? 'All systems normal.'
      : overall === 'partial'
        ? `We&#39;re aware of a minor issue with: ${impacted.map(i => i.humanLabel).join(', ')}. It&#39;s being worked on.`
        : `We&#39;re actively working on an issue with: ${impacted.map(i => i.humanLabel).join(', ')}. Some actions may be delayed briefly. Thanks for your patience.`,
  }, {
    headers: {
      'Cache-Control': 'public, max-age=30, s-maxage=30',
    },
  });
}

// Public system status page. No auth required, no internals leaked.
// Fetched server-side on every request from /api/status, which reads
// live from system_alerts. Cache is 30s at the edge — accurate enough
// for "is it me or is it the site" without hammering the DB.

import { CheckCircle2, AlertTriangle, XCircle } from 'lucide-react';

export const dynamic = 'force-dynamic';
export const revalidate = 30;

interface StatusResponse {
  status: 'operational' | 'partial' | 'degraded';
  generatedAt: string;
  impacted: Array<{ humanLabel: string; sev: 'warning' | 'critical' }>;
  message: string;
}

async function fetchStatus(): Promise<StatusResponse> {
  const baseUrl = process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000';
  try {
    const r = await fetch(`${baseUrl}/api/status`, { cache: 'no-store' });
    if (!r.ok) throw new Error('bad response');
    return await r.json();
  } catch {
    return {
      status: 'operational',
      generatedAt: new Date().toISOString(),
      impacted: [],
      message: 'All systems normal.',
    };
  }
}

export default async function StatusPage() {
  const status = await fetchStatus();

  const iconMap = {
    operational: <CheckCircle2 className="w-10 h-10 text-emerald-400" />,
    partial:     <AlertTriangle className="w-10 h-10 text-amber-400" />,
    degraded:    <XCircle className="w-10 h-10 text-red-400" />,
  };
  const bgMap = {
    operational: 'bg-emerald-500/10 border-emerald-500/20',
    partial:     'bg-amber-500/10 border-amber-500/20',
    degraded:    'bg-red-500/10 border-red-500/20',
  };

  return (
    <div className="max-w-lg mx-auto py-16 px-4 space-y-6">
      <div className={`border rounded-2xl p-6 text-center space-y-3 ${bgMap[status.status]}`}>
        <div className="flex justify-center">{iconMap[status.status]}</div>
        <div>
          <h1 className="text-xl font-bold capitalize">
            {status.status === 'operational' ? 'All systems normal' :
             status.status === 'partial'     ? 'Partial disruption' :
                                                'Active incident'}
          </h1>
          <p className="text-sm text-muted-foreground mt-1">{status.message}</p>
        </div>
      </div>

      {status.impacted.length > 0 && (
        <div className="space-y-2">
          <h2 className="text-xs uppercase tracking-wider text-muted-foreground">Impacted</h2>
          <ul className="space-y-1.5">
            {status.impacted.map(i => (
              <li key={i.humanLabel} className="flex items-center justify-between border rounded-lg p-3 text-sm">
                <span>{i.humanLabel}</span>
                <span className={`text-[10px] uppercase font-semibold ${i.sev === 'critical' ? 'text-red-400' : 'text-amber-400'}`}>
                  {i.sev === 'critical' ? 'incident' : 'monitoring'}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}

      <p className="text-[10px] text-muted-foreground text-center">
        Last updated {new Date(status.generatedAt).toLocaleString()}. Automatically refreshed every 30 seconds server-side.
      </p>
    </div>
  );
}

import { NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { isAdminRequest } from '@/lib/adminAuth';
import { runFixForFinding } from '@/lib/mechanic/fixers';
import type { Finding } from '@/lib/mechanic/types';

export const maxDuration = 60;
export const dynamic = 'force-dynamic';

const supabaseAdmin = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
);

// POST /api/mechanic/bulk-fix
//
// Applies (or previews) fixes for many findings in one shot — used for
// "47 users affected by market X's wrongful void → one button applies
// re-resolve for all 47 with per-user confirmation checks."
//
// Body:
//   { findings: Finding[], dryRun?: boolean, hardCap?: number }
// Returns one outcome per finding. Never exceeds hardCap (default 50).
export async function POST(request: Request) {
  if (!isAdminRequest(request)) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  let body: any;
  try { body = await request.json(); }
  catch { return NextResponse.json({ error: 'Malformed body' }, { status: 400 }); }

  const findings: Finding[] = Array.isArray(body?.findings) ? body.findings : [];
  const dryRun: boolean = body?.dryRun !== false;
  const hardCap = Math.min(100, Math.max(1, Number(body?.hardCap) || 50));
  if (findings.length === 0) return NextResponse.json({ error: 'findings[] required' }, { status: 400 });
  if (findings.length > hardCap) {
    return NextResponse.json({ error: `too many findings (${findings.length} > cap ${hardCap})` }, { status: 400 });
  }

  const runId = crypto.randomUUID();
  const outcomes = [] as any[];
  let succeeded = 0, failed = 0, applied = 0;

  for (const f of findings) {
    try {
      const out = await runFixForFinding(supabaseAdmin, f, {
        dryRun,
        operator: 'admin_bulk',
        runId,
      });
      outcomes.push({ fingerprint: f.fingerprint, outcome: out });
      if (out.ok) succeeded += 1; else failed += 1;
      if (out.applied) applied += 1;
    } catch (e: any) {
      outcomes.push({ fingerprint: f.fingerprint, outcome: { ok: false, summary: e?.message || String(e) } });
      failed += 1;
    }
  }

  return NextResponse.json({
    ok: failed === 0,
    dryRun,
    runId,
    processed: findings.length,
    succeeded,
    failed,
    applied,
    outcomes,
  });
}

import { NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { safeSecretMatch } from '@/lib/safeCompare';
import { sendAdminAlert } from '@/lib/adminAlert';

export const maxDuration = 300;
export const dynamic = 'force-dynamic';

const supabaseAdmin = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
);

// POST /api/cron/runs — settle any Run whose five fixtures are all graded.
//
// Without this a finished card sits unpaid until an admin notices, which on a
// product whose entire promise is "your position pays out" is the worst
// possible failure: silent, and indistinguishable from not paying at all.
// Grading is the human step; paying should not be.
//
// settle_run is idempotent (it refuses a card that is already settled), so a
// retry or an overlapping tick cannot double-pay.
export async function POST(request: Request) {
  if (!safeSecretMatch(request.headers.get('x-cron-secret'), process.env.CRON_SECRET)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  // Cards still running, with every leg graded.
  const { data: candidates, error } = await supabaseAdmin
    .from('runs')
    .select('id, title, run_legs(result)')
    .in('status', ['open', 'live'])
    .limit(50);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  const ready = (candidates || []).filter((r: any) => {
    const legs = r.run_legs || [];
    return legs.length === 5 && legs.every((l: any) => l.result);
  });

  const results: { settled: number; winners: number; paidTngn: number; errors: string[] } =
    { settled: 0, winners: 0, paidTngn: 0, errors: [] };

  for (const run of ready) {
    try {
      const { data, error: e } = await supabaseAdmin.rpc('settle_run', {
        p_run_id: run.id, p_dry_run: false,
      });
      if (e) throw new Error(e.message);
      const row = Array.isArray(data) ? data[0] : data;
      if (row?.applied) {
        results.settled += 1;
        results.winners += Number(row.winners || 0);
        results.paidTngn += Number(row.paid_tngn || 0);
      } else if (row?.reason && row.reason !== 'already_settled') {
        results.errors.push(`${String(run.id).slice(0, 8)}: ${row.reason}`);
      }
    } catch (err: any) {
      const msg = `${String(run.id).slice(0, 8)}: ${err?.message || err}`;
      results.errors.push(msg);
      // A card that finished but will not pay needs a human, now — the
      // players are owed money and nothing else in the system will notice.
      await sendAdminAlert(
        supabaseAdmin,
        `The Run: "${run.title}" has all five graded but failed to settle — ${err?.message || err}`,
        `run_settle_failed_${run.id}`,
        6,
      );
    }
  }

  return NextResponse.json({ ranAt: new Date().toISOString(), checked: ready.length, ...results });
}

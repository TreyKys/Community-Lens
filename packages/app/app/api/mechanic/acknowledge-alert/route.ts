import { NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { isAdminRequest } from '@/lib/adminAuth';

const supabaseAdmin = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
);

// POST /api/mechanic/acknowledge-alert
//
// For findings that need a human judgment call rather than a
// deterministic fix (voided_empty_duplicate, never_resolved's "nothing
// to do here" case, etc.) — lets an admin explicitly close the alert
// with a note, instead of it sitting in the queue forever with no way
// to say "reviewed, no action needed".
//
// Body: { fingerprint: string, note?: string }
//
// Distinct from a scan's own auto-resolve (which fires when the
// underlying condition disappears): this is a manual "I looked at
// this, it's fine" call, so it sticks even if the scan keeps re-
// detecting the same underlying (unchanging) condition — e.g. two
// permanently-duplicate market rows will show up on every scan forever
// unless someone marks it reviewed.
export async function POST(request: Request) {
  if (!isAdminRequest(request)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  let body: any;
  try { body = await request.json(); }
  catch { return NextResponse.json({ error: 'Malformed body' }, { status: 400 }); }

  const fingerprint = String(body?.fingerprint || '').trim();
  const note = body?.note ? String(body.note).slice(0, 1000) : null;
  if (!fingerprint) return NextResponse.json({ error: 'Provide fingerprint' }, { status: 400 });

  const { data, error } = await supabaseAdmin
    .from('system_alerts')
    .update({
      status: 'admin_resolved',
      resolved_at: new Date().toISOString(),
      resolved_by: 'admin_reviewed',
      acknowledged_at: new Date().toISOString(),
    })
    .eq('fingerprint', fingerprint)
    .select('id')
    .maybeSingle();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  await supabaseAdmin.from('mechanic_log').insert({
    run_id: crypto.randomUUID(),
    scan_category: 'manual',
    action: 'skip',
    operator: 'admin_cookie',
    issue_type: 'manual_acknowledge',
    issue_key: fingerprint,
    affected_count: 1,
    details: { note },
    succeeded: true,
  });

  return NextResponse.json({ ok: true, found: !!data });
}

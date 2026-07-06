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

// POST /api/mechanic/fix
//
// One entry point for applying (or previewing) any Mechanic fix. Body:
//   {
//     finding: <the full Finding object from /api/mechanic/scan>,
//     dryRun?: boolean       // default TRUE — must be false to actually run
//   }
//
// dryRun defaults to true so a stray click can't move money. UI flows
// call once with dryRun=true, show the preview, then call again with
// dryRun=false only after the admin confirms.
export async function POST(request: Request) {
  if (!isAdminRequest(request)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  let body: any;
  try { body = await request.json(); }
  catch { return NextResponse.json({ error: 'Malformed body' }, { status: 400 }); }

  const finding: Finding | undefined = body?.finding;
  const dryRun: boolean = body?.dryRun !== false;
  if (!finding || !finding.issueType) {
    return NextResponse.json({ error: 'Provide finding: { issueType, ..., affectedIds }' }, { status: 400 });
  }

  // operator id: prefer the acting admin's user_id if we can extract it,
  // otherwise a stable 'admin_cookie' marker so mechanic_log knows this
  // wasn't the cron.
  const operator = 'admin_cookie';

  try {
    const outcome = await runFixForFinding(supabaseAdmin, finding, {
      dryRun,
      operator,
    });
    return NextResponse.json({ ok: outcome.ok, dryRun, outcome });
  } catch (e: any) {
    console.error('/api/mechanic/fix crashed:', e);
    return NextResponse.json({ error: e?.message || String(e) }, { status: 500 });
  }
}

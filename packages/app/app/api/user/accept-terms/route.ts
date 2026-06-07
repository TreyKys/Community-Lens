import { NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';

const supabaseAdmin = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

// Bump this whenever the T&Cs change materially. Existing acceptances
// remain valid for prior versions; users will need to re-accept on a
// version mismatch handled by the client.
const CURRENT_TOS_VERSION = '2026-06-07';

export async function POST(request: Request) {
  try {
    const auth = request.headers.get('Authorization');
    if (!auth) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

    const token = auth.replace('Bearer ', '');
    const { data: { user }, error: authError } = await supabaseAdmin.auth.getUser(token);
    if (authError || !user) {
      return NextResponse.json({ error: 'Invalid session' }, { status: 401 });
    }

    // Idempotent — already-accepted users get a no-op success
    const { data: existing } = await supabaseAdmin
      .from('users')
      .select('tos_version')
      .eq('id', user.id)
      .single();

    if (existing?.tos_version === CURRENT_TOS_VERSION) {
      return NextResponse.json({ ok: true, alreadyAccepted: true, version: CURRENT_TOS_VERSION });
    }

    await supabaseAdmin
      .from('users')
      .update({
        tos_accepted_at: new Date().toISOString(),
        tos_version: CURRENT_TOS_VERSION,
      })
      .eq('id', user.id);

    // Audit-log entry. Captures IP + UA for litigation defense.
    const ip = request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() || null;
    const ua = request.headers.get('user-agent') || null;
    await supabaseAdmin.from('terms_acceptance_log').insert({
      user_id: user.id,
      tos_version: CURRENT_TOS_VERSION,
      ip_address: ip,
      user_agent: ua,
    });

    return NextResponse.json({ ok: true, version: CURRENT_TOS_VERSION });
  } catch (e: any) {
    console.error('accept-terms error', e);
    return NextResponse.json({ error: e.message || 'Internal error' }, { status: 500 });
  }
}

export async function GET() {
  return NextResponse.json({ currentVersion: CURRENT_TOS_VERSION });
}

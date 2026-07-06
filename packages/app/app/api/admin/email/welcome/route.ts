import { NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { isAdminRequest } from '@/lib/adminAuth';
import { sendWelcomeEmail, renderWelcomeEmailHtml } from '@/lib/welcome-email';

const supabaseAdmin = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

// POST /api/admin/email/welcome
// Body: { userLookup: string }  // user_id (UUID) or email
//
// Admin-triggered send. Used when:
//   - Welcome email failed for a user and you want to retry.
//   - Resend was down when they signed up; you're sending after the fact.
//   - You manually re-credited someone and want to send the welcome
//     alongside.
//
// Resets welcome_email_sent_at first so the idempotency guard in
// sendWelcomeEmail doesn't skip the retry.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function POST(request: Request) {
  if (!isAdminRequest(request)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const body = await request.json().catch(() => ({} as any));
    const lookup = String(body?.userLookup || '').trim();
    if (!lookup) return NextResponse.json({ error: 'userLookup required' }, { status: 400 });

    const query = UUID_RE.test(lookup)
      ? supabaseAdmin.from('users').select('id, email').eq('id', lookup)
      : supabaseAdmin.from('users').select('id, email').eq('email', lookup.toLowerCase());
    const { data: user } = await query.maybeSingle();
    if (!user) return NextResponse.json({ error: 'User not found' }, { status: 404 });

    // Force re-send by clearing the gate column.
    await supabaseAdmin
      .from('users')
      .update({ welcome_email_sent_at: null })
      .eq('id', user.id);

    const result = await sendWelcomeEmail(user.id, supabaseAdmin);
    return NextResponse.json({ ...result, email: user.email });
  } catch (e: any) {
    return NextResponse.json({ error: e?.message || 'Internal error' }, { status: 500 });
  }
}

// GET /api/admin/email/welcome?userLookup=email|uuid
//
// Returns the rendered HTML as text/html so you can preview the email
// directly in a browser tab. Useful for:
//   - Eyeballing what a specific user will see.
//   - Sending the email manually while Resend is down — open the page,
//     "Save Page As" -> HTML, attach to your manual send.
export async function GET(request: Request) {
  if (!isAdminRequest(request)) {
    return new NextResponse('Unauthorized', { status: 401 });
  }

  try {
    const { searchParams } = new URL(request.url);
    const lookup = (searchParams.get('userLookup') || '').trim();
    if (!lookup) return new NextResponse('userLookup required', { status: 400 });

    const query = UUID_RE.test(lookup)
      ? supabaseAdmin.from('users').select('email, first_name, username').eq('id', lookup)
      : supabaseAdmin.from('users').select('email, first_name, username').eq('email', lookup.toLowerCase());
    const { data: user } = await query.maybeSingle();
    if (!user) return new NextResponse('User not found', { status: 404 });

    // Inline the firstName picker so we don't have to export it.
    const firstName =
      (user.first_name && String(user.first_name).trim().split(/\s+/)[0]) ||
      (user.username && String(user.username).trim().split(/\s+/)[0]) ||
      (user.email && user.email.split('@')[0].split(/[._-]/)[0].slice(0, 24)) ||
      'there';

    const html = renderWelcomeEmailHtml(firstName);
    return new NextResponse(html, { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
  } catch (e: any) {
    return new NextResponse(`Error: ${e?.message || 'unknown'}`, { status: 500 });
  }
}

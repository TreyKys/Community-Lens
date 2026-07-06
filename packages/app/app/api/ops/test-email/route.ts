import { NextResponse } from 'next/server';
import { isAdminRequest } from '@/lib/adminAuth';
import { sendOpsEmail } from '@/lib/ops-email';

/**
 * GET /api/ops/test-email
 *
 * Admin-gated diagnostic: fires a single test email to OPS_EMAIL so you
 * can confirm Resend setup is working without doing a real withdrawal.
 * Returns the result of the send (success/failure surfaces in the JSON +
 * Netlify function logs).
 */
export async function GET(request: Request) {
  if (!isAdminRequest(request)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const hasKey = !!process.env.RESEND_API_KEY;
  const from = process.env.RESEND_FROM || '(default onboarding@resend.dev)';
  const to = process.env.OPS_EMAIL || 'hello@neurodevlabs.cloud';

  if (!hasKey) {
    return NextResponse.json({
      ok: false,
      reason: 'RESEND_API_KEY not set in Netlify env',
      from,
      to,
    });
  }

  await sendOpsEmail({
    subject: '✅ Opinions.ng ops-email test',
    html: `
      <div style="font-family:system-ui;max-width:480px;color:#111">
        <h2 style="margin:0 0 10px">Test email working</h2>
        <p>If you can read this, ops alerts will fire on every new withdrawal.</p>
        <p style="font-size:12px;color:#666">Sent ${new Date().toISOString()}</p>
      </div>
    `,
  });

  return NextResponse.json({ ok: true, sent_to: to, from, hint: 'Check inbox + spam folder. If nothing arrives, look at Netlify function logs for [ops-email] entries.' });
}

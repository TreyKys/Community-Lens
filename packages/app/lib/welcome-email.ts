/**
 * lib/welcome-email.ts
 * Branded post-signup welcome email. Renders the HTML and ships it to
 * the user via Resend. Designed to be fire-and-forget — never blocks
 * the user-facing path if the email fails.
 */

import type { SupabaseClient } from '@supabase/supabase-js';

const RESEND_ENDPOINT = 'https://api.resend.com/emails';
const DEFAULT_FROM = 'Opinions.ng <onboarding@resend.dev>';

interface UserLite {
  email: string;
  first_name?: string | null;
  username?: string | null;
}

function pickFirstName(u: UserLite): string {
  // First non-empty wins. Falls back to a safe generic if everything is
  // null so we never render literal "{{ first_name }}" to a real user.
  if (u.first_name && u.first_name.trim()) return u.first_name.trim().split(/\s+/)[0];
  if (u.username && u.username.trim()) return u.username.trim().split(/\s+/)[0];
  if (u.email) return u.email.split('@')[0].split(/[._-]/)[0].slice(0, 24) || 'there';
  return 'there';
}

export function renderWelcomeEmailHtml(firstName: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Welcome to Opinions.ng</title>
</head>
<body style="margin:0;padding:0;background:#050A08;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;-webkit-font-smoothing:antialiased;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#050A08;padding:32px 16px;">
    <tr>
      <td align="center">
        <table role="presentation" width="560" cellpadding="0" cellspacing="0" border="0" style="max-width:560px;background:#0B1411;border:1px solid rgba(16,185,129,0.18);border-radius:16px;overflow:hidden;">
          <tr>
            <td style="padding:32px 32px 8px 32px;">
              <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
                <tr>
                  <td>
                    <div style="display:inline-block;width:36px;height:36px;background:linear-gradient(135deg,#34d399,#10b981);border-radius:9px;text-align:center;line-height:36px;font-weight:900;color:#050A08;font-size:18px;">&#x25C8;</div>
                    <span style="margin-left:12px;color:#ffffff;font-size:18px;font-weight:800;letter-spacing:0.5px;vertical-align:middle;">OPINIONS.NG</span>
                  </td>
                </tr>
              </table>
            </td>
          </tr>
          <tr>
            <td style="padding:24px 32px 0 32px;">
              <p style="margin:0;color:#ffffff;font-size:22px;font-weight:800;line-height:1.3;">Nice work signing up for Opinions.ng, ${escapeHtml(firstName)}.</p>
              <p style="margin:14px 0 0 0;color:#94a3b8;font-size:15px;line-height:1.6;">You&rsquo;re in. Nigeria&rsquo;s prediction market just got one sharper opinion.</p>
            </td>
          </tr>
          <tr>
            <td style="padding:32px 32px 0 32px;">
              <p style="margin:0 0 16px 0;color:#34d399;font-size:11px;font-weight:700;letter-spacing:2px;text-transform:uppercase;">What&rsquo;s next</p>
              <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
                <tr>
                  <td valign="top" style="width:32px;padding:8px 0;">
                    <div style="width:24px;height:24px;background:rgba(16,185,129,0.15);color:#34d399;border-radius:50%;text-align:center;line-height:24px;font-weight:700;font-size:13px;">1</div>
                  </td>
                  <td style="padding:8px 0 8px 12px;color:#e2e8f0;font-size:15px;line-height:1.5;"><strong style="color:#ffffff;">Make your first deposit</strong> &mdash; we match it 100%. Deposit &#8358;1,000, predict with &#8358;2,000.</td>
                </tr>
                <tr>
                  <td valign="top" style="width:32px;padding:8px 0;">
                    <div style="width:24px;height:24px;background:rgba(16,185,129,0.15);color:#34d399;border-radius:50%;text-align:center;line-height:24px;font-weight:700;font-size:13px;">2</div>
                  </td>
                  <td style="padding:8px 0 8px 12px;color:#e2e8f0;font-size:15px;line-height:1.5;"><strong style="color:#ffffff;">Start predicting.</strong> Football, politics, pop culture, the economy. Pick a side.</td>
                </tr>
                <tr>
                  <td valign="top" style="width:32px;padding:8px 0;">
                    <div style="width:24px;height:24px;background:rgba(16,185,129,0.15);color:#34d399;border-radius:50%;text-align:center;line-height:24px;font-weight:700;font-size:13px;">3</div>
                  </td>
                  <td style="padding:8px 0 8px 12px;color:#e2e8f0;font-size:15px;line-height:1.5;"><strong style="color:#ffffff;">Follow our socials</strong> so you don&rsquo;t miss big events.</td>
                </tr>
              </table>
              <table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin-top:16px;">
                <tr>
                  <td style="padding-right:10px;">
                    <a href="https://x.com/opinions_ng" style="display:inline-block;padding:10px 18px;background:#ffffff;color:#050A08;font-size:13px;font-weight:700;text-decoration:none;border-radius:8px;">Follow on X</a>
                  </td>
                  <td>
                    <a href="https://www.instagram.com/opinionshq_ng" style="display:inline-block;padding:10px 18px;background:linear-gradient(135deg,#f9ce34,#ee2a7b,#6228d7);color:#ffffff;font-size:13px;font-weight:700;text-decoration:none;border-radius:8px;">Follow on Instagram</a>
                  </td>
                </tr>
              </table>
            </td>
          </tr>
          <tr>
            <td style="padding:32px 32px 0 32px;">
              <div style="border-left:3px solid #10b981;padding:4px 0 4px 16px;">
                <p style="margin:0;color:#ffffff;font-size:18px;font-weight:800;line-height:1.4;">It&rsquo;s that simple.</p>
                <p style="margin:8px 0 0 0;color:#cbd5e1;font-size:15px;line-height:1.6;">You have an opinion and you&rsquo;re getting rewarded for it. That&rsquo;s it.</p>
              </div>
            </td>
          </tr>
          <tr>
            <td style="padding:28px 32px 0 32px;">
              <div style="background:linear-gradient(135deg,rgba(16,185,129,0.12),rgba(5,150,105,0.04));border:1px solid rgba(16,185,129,0.25);border-radius:12px;padding:18px 20px;">
                <p style="margin:0;color:#34d399;font-size:11px;font-weight:700;letter-spacing:2px;text-transform:uppercase;">Something big is coming</p>
                <p style="margin:8px 0 0 0;color:#ffffff;font-size:16px;font-weight:700;line-height:1.4;">Share your referral link and anticipate.</p>
                <p style="margin:8px 0 0 0;color:#94a3b8;font-size:13px;line-height:1.5;">The earliest believers get more than the latest ones. Don&rsquo;t watch others get paid for the prediction you saw first.</p>
                <a href="https://opinionsng.com/profile" style="display:inline-block;margin-top:14px;padding:11px 22px;background:#10b981;color:#050A08;font-size:13px;font-weight:800;text-decoration:none;border-radius:8px;letter-spacing:0.3px;">Get your referral link &rarr;</a>
              </div>
            </td>
          </tr>
          <tr>
            <td style="padding:36px 32px 28px 32px;">
              <p style="margin:0;color:#475569;font-size:11px;line-height:1.6;">You&rsquo;re getting this because you signed up at opinionsng.com. Opinions.ng is a real-money prediction market for Nigerian events. You must be 18+. Predict responsibly.</p>
              <p style="margin:12px 0 0 0;color:#475569;font-size:11px;">
                <a href="https://opinionsng.com/terms" style="color:#64748b;text-decoration:underline;">Terms</a> &middot;
                <a href="https://opinionsng.com/privacy" style="color:#64748b;text-decoration:underline;">Privacy</a> &middot;
                <a href="https://opinionsng.com" style="color:#64748b;text-decoration:underline;">opinionsng.com</a>
              </p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;
}

// Cheap HTML escape for the first name. We don't escape the rest of the
// template because it's a static constant — only the user-supplied bit
// can introduce stray markup.
function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Look up the user, render the email, and ship via Resend. Idempotent
 * at the call-site level (we set users.welcome_email_sent_at after a
 * successful send so accept-terms re-runs don't re-mail the user).
 * Returns { sent, skipped } so callers can log/inspect — never throws.
 */
export async function sendWelcomeEmail(
  userId: string,
  db: SupabaseClient,
): Promise<{ sent: boolean; skipped?: string; error?: string }> {
  try {
    const apiKey = process.env.RESEND_API_KEY;
    if (!apiKey) return { sent: false, skipped: 'no-resend-key' };

    const { data: user, error } = await db
      .from('users')
      .select('email, first_name, username, welcome_email_sent_at')
      .eq('id', userId)
      .maybeSingle();
    if (error || !user) return { sent: false, skipped: 'user-not-found' };
    if (!user.email)    return { sent: false, skipped: 'no-email' };
    if (user.welcome_email_sent_at) return { sent: false, skipped: 'already-sent' };

    const firstName = pickFirstName(user as UserLite);
    const html = renderWelcomeEmailHtml(firstName);
    const from = process.env.RESEND_FROM || DEFAULT_FROM;
    const subject = `Welcome to Opinions.ng, ${firstName}`;

    const res = await fetch(RESEND_ENDPOINT, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ from, to: user.email, subject, html }),
    });

    if (!res.ok) {
      const body = await res.text().catch(() => '');
      console.error(`[welcome-email] Resend ${res.status} — ${body.slice(0, 400)}`);
      return { sent: false, error: `resend-${res.status}` };
    }

    // Mark sent so accept-terms re-runs / admin re-sends don't double-mail
    // by accident. The column is optional — silently ignore if the
    // migration adding it hasn't been applied yet.
    await db.from('users')
      .update({ welcome_email_sent_at: new Date().toISOString() })
      .eq('id', userId);

    return { sent: true };
  } catch (e: any) {
    console.error('[welcome-email] send failed:', e?.message || e);
    return { sent: false, error: e?.message || 'unknown' };
  }
}

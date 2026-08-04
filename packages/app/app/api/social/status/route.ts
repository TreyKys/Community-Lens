import { NextResponse } from 'next/server';
import { isAdminRequest } from '@/lib/adminAuth';
import { getSupabaseAdmin } from '@/lib/oracle';
import { budgetSummary } from '@/lib/social/budget';

// GET /api/social/status
//
// One call that answers three questions: is it configured, is it
// healthy, and what has it cost. Admin-only — spend figures and the
// pending queue are not public.
//
// The `setup` block exists because the alternative is guessing. Every
// piece of this system fails silently when misconfigured: a missing
// X key makes the publisher a no-op, an unregistered Telegram webhook
// makes the buttons do nothing, and zero active targets makes the
// scanner return successfully having done nothing at all. None of those
// look like errors in a cron log.

export const dynamic = 'force-dynamic';

/** Presence only — never the value. This response goes over the wire. */
const present = (v: string | undefined) => Boolean(v && v.length > 0);

/**
 * Ask Telegram whether our webhook is actually registered, and where.
 *
 * The single most common setup failure is registering the webhook
 * against the wrong host (localhost, a preview URL, http instead of
 * https) — Telegram accepts it happily and the buttons then do nothing
 * forever, with no error anywhere.
 */
async function telegramWebhookState(): Promise<Record<string, unknown>> {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) return { configured: false, reason: 'TELEGRAM_BOT_TOKEN not set' };

  try {
    const r = await fetch(`https://api.telegram.org/bot${token}/getWebhookInfo`, {
      signal: AbortSignal.timeout(5000),
    });
    const json = await r.json();
    if (!json?.ok) return { configured: false, reason: 'bot token rejected by Telegram' };

    const info = json.result ?? {};
    const expected = `${process.env.NEXT_PUBLIC_APP_URL ?? ''}/api/social/telegram`;
    return {
      configured: Boolean(info.url),
      url: info.url || null,
      matchesAppUrl: Boolean(info.url) && info.url === expected,
      expected,
      hasSecretToken: Boolean(info.has_custom_certificate) || Boolean(info.url),
      pendingUpdateCount: info.pending_update_count ?? 0,
      // Telegram surfaces the last delivery failure here. If the buttons
      // are dead, this field usually says exactly why.
      lastErrorMessage: info.last_error_message ?? null,
      lastErrorDate: info.last_error_date
        ? new Date(info.last_error_date * 1000).toISOString()
        : null,
    };
  } catch (e: any) {
    return { configured: false, reason: `could not reach Telegram: ${e?.message}` };
  }
}

export async function GET(request: Request) {
  if (!isAdminRequest(request)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const supa = getSupabaseAdmin();
  const since = new Date(Date.now() - 7 * 24 * 3600 * 1000).toISOString();

  const [budget, posts, replies, recent, activeTargets, queued, telegram] = await Promise.all([
    budgetSummary().catch((e) => ({ error: String(e?.message ?? e) })),
    supa.from('social_posts').select('status').gte('created_at', since),
    supa.from('social_replies').select('status').gte('created_at', since),
    supa
      .from('social_posts')
      .select('id, kind, body, status, scheduled_at, published_at, provider_post_id, last_error')
      .order('created_at', { ascending: false })
      .limit(15),
    supa.from('social_targets').select('handle').eq('active', true),
    supa.from('social_posts').select('id', { count: 'exact', head: true }).eq('status', 'queued'),
    telegramWebhookState(),
  ]);

  const tally = (rows: any[] | null) =>
    (rows ?? []).reduce<Record<string, number>>((acc, r) => {
      acc[r.status] = (acc[r.status] ?? 0) + 1;
      return acc;
    }, {});

  const xKeys = {
    X_API_KEY: present(process.env.X_API_KEY),
    X_API_SECRET: present(process.env.X_API_SECRET),
    X_ACCESS_TOKEN: present(process.env.X_ACCESS_TOKEN),
    X_ACCESS_SECRET: present(process.env.X_ACCESS_SECRET),
  };

  const activeHandles = (activeTargets.data ?? []).map((t: any) => t.handle);

  // Ordered worst-first: each of these means a part of the system is
  // silently doing nothing.
  const blockers: string[] = [];
  if (Object.values(xKeys).some((v) => !v)) {
    blockers.push('X credentials incomplete — publisher and scanner are no-ops');
  }
  if (!present(process.env.TELEGRAM_BOT_TOKEN) || !present(process.env.TELEGRAM_CHAT_ID)) {
    blockers.push('Telegram not configured — no reply cards will reach you');
  } else if (!(telegram as any).configured) {
    blockers.push('Telegram webhook not registered — Posted/Skip buttons will do nothing');
  } else if ((telegram as any).matchesAppUrl === false) {
    blockers.push(
      `Telegram webhook points at ${(telegram as any).url} but this app is ` +
      `${(telegram as any).expected} — buttons will not reach this server`,
    );
  }
  if (!present(process.env.TELEGRAM_WEBHOOK_SECRET)) {
    blockers.push('TELEGRAM_WEBHOOK_SECRET not set — the webhook rejects every delivery');
  }
  if (!present(process.env.GEMINI_API_KEY)) {
    blockers.push('GEMINI_API_KEY not set — nothing can be drafted');
  }
  if (activeHandles.length === 0) {
    blockers.push('no active social_targets — the scanner will find nothing to reply to');
  }

  return NextResponse.json({
    setup: {
      ready: blockers.length === 0,
      blockers,
      x: xKeys,
      gemini: present(process.env.GEMINI_API_KEY),
      telegram: {
        botToken: present(process.env.TELEGRAM_BOT_TOKEN),
        chatId: present(process.env.TELEGRAM_CHAT_ID),
        webhookSecret: present(process.env.TELEGRAM_WEBHOOK_SECRET),
        webhook: telegram,
      },
      activeTargets: activeHandles,
      queuedPosts: queued.count ?? 0,
    },
    budget,
    last7Days: {
      posts: tally(posts.data),
      replies: tally(replies.data),
    },
    recentPosts: recent.data ?? [],
  });
}

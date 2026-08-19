// Telegram command handling — the operator's control panel.
//
// The requirement this serves: the pipeline spends money on a schedule
// with nobody watching, so the operator must be able to see what it is
// about to do and stop it, from a phone, in seconds. Everything here is
// reachable without an SSH session or a deploy.

import { getSupabaseAdmin } from '@/lib/oracle';
import { budgetSummary } from './budget';
import { getSettings, setPaused, setDailyCap, setAllowPaidLookup } from './settings';

const escapeHtml = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

const HELP = `<b>Opinions.ng social bot</b>

<b>Writing posts</b>
<code>/draft 4 BBN posts</code>
<code>/draft 3 posts about the Super Eagles squad</code>
<code>/draft something about the naira this week</code>

You tell me the subject; I write the posts and send them one at a time
with Queue / Discard buttons. Tap Queue and it takes the next free slot.
Doesn't have to be about anything on the site.

<b>Drafting a reply</b>
Send an X post link — or paste a post's text — and I'll draft a reply, free.
Link + the text pasted underneath works best: no lookup needed.

<b>Control</b>
/preview — every queued post, with its image, before it goes out
/drafts — re-send any drafts still waiting on a decision
/status — what's queued, what's paused, what it cost
/queue — the next posts due
/budget — spend this month
/pause [reason] — stop publishing now
/resume — start publishing again
/cap N — max posts per day (0-20, /cap off to clear)
/skip ID — cancel one queued post
/paidlookup on|off — allow a $0.005 read when a share can't be read free
/help — this`;

/**
 * Commands the webhook handles itself rather than through
 * handleCommand.
 *
 * These send SEVERAL messages (one card per draft) instead of returning
 * one reply, and they run long enough to need an acknowledgement first
 * — so they cannot fit the "command in, string out" shape below.
 */
const MULTI_MESSAGE = new Set(['/draft', '/post', '/write', '/drafts', '/preview']);

/** Normalise "/Draft@MyBot" to "/draft". */
export function commandName(text: string): string {
  return text.trim().split(/\s+/)[0].toLowerCase().replace(/@[\w_]+$/, '');
}

export function isMultiMessageCommand(text: string): boolean {
  return MULTI_MESSAGE.has(commandName(text));
}

export async function handleCommand(text: string): Promise<string> {
  const [rawCmd, ...args] = text.trim().split(/\s+/);
  const cmd = rawCmd.toLowerCase().replace(/@[\w_]+$/, ''); // strip @botname
  const arg = args.join(' ').trim();

  switch (cmd) {
    case '/start':
    case '/help':
      return HELP;

    case '/budget':
      return renderBudget();

    case '/status':
      return renderStatus();

    case '/queue':
      return renderQueue();

    case '/pause': {
      await setPaused(true, arg || 'paused from Telegram');
      return `⏸ <b>Publishing paused.</b>\nNothing will post until /resume.${arg ? `\n\nReason: ${escapeHtml(arg)}` : ''}`;
    }

    case '/resume': {
      await setPaused(false);
      return `▶️ <b>Publishing resumed.</b>\nThe next hourly run will pick up anything due.`;
    }

    case '/cap': {
      if (/^off$/i.test(arg)) {
        await setDailyCap(null);
        return `Cap cleared — falling back to SOCIAL_DAILY_POST_CAP from the environment.`;
      }
      const n = Number(arg);
      if (!Number.isInteger(n) || n < 0 || n > 20) {
        return `Usage: <code>/cap 3</code> (0-20), or <code>/cap off</code> to clear.`;
      }
      await setDailyCap(n);
      return n === 0
        ? `Cap set to <b>0</b> — the planner will queue nothing. (/pause is the better stop button; this one still lets already-queued posts go out.)`
        : `Cap set to <b>${n} posts/day</b>.`;
    }

    case '/paidlookup': {
      if (!/^(on|off)$/i.test(arg)) return `Usage: <code>/paidlookup on</code> or <code>/paidlookup off</code>`;
      const on = /^on$/i.test(arg);
      await setAllowPaidLookup(on);
      return on
        ? `Paid lookups <b>ON</b>. A shared post that can't be read for free will cost $0.005.`
        : `Paid lookups <b>OFF</b>. Shares that can't be read free will ask you to paste the text instead.`;
    }

    case '/skip': {
      const id = Number(arg);
      if (!Number.isInteger(id)) return `Usage: <code>/skip 42</code> — the id from /queue.`;
      const supa = getSupabaseAdmin();
      const { data } = await supa
        .from('social_posts')
        .update({ status: 'cancelled', last_error: 'cancelled from Telegram' })
        .eq('id', id)
        .eq('status', 'queued')
        .select('id');
      return data?.length
        ? `🗑 Post #${id} cancelled.`
        : `Nothing to cancel — #${id} isn't queued (already published, or not found).`;
    }

    default:
      return `Unknown command. /help for the list.`;
  }
}

async function renderBudget(): Promise<string> {
  const b = await budgetSummary().catch(() => null);
  if (!b) return `Couldn't read the spend ledger.`;

  const bar = '█'.repeat(Math.round(b.pctUsed / 10)) + '░'.repeat(10 - Math.round(b.pctUsed / 10));
  return (
    `<b>X spend this month</b>\n` +
    `<code>${bar}</code> ${b.pctUsed}%\n\n` +
    `Spent: $${b.spentUsd.toFixed(3)} (₦${b.spentNgn.toLocaleString()})\n` +
    `Cap:   $${b.capUsd.toFixed(2)} (₦${b.capNgn.toLocaleString()})\n` +
    `Left:  $${b.remainingUsd.toFixed(3)} — about ${Math.floor(b.remainingUsd / 0.015)} more posts`
  );
}

async function renderStatus(): Promise<string> {
  const supa = getSupabaseAdmin();
  const [settings, budget, queued, today] = await Promise.all([
    getSettings(),
    budgetSummary().catch(() => null),
    supa.from('social_posts').select('id', { count: 'exact', head: true }).eq('status', 'queued'),
    supa
      .from('social_posts')
      .select('id', { count: 'exact', head: true })
      .eq('status', 'published')
      .gte('published_at', new Date(Date.now() - 24 * 3600 * 1000).toISOString()),
  ]);

  const state = settings.publishingPaused
    ? `⏸ <b>PAUSED</b>${settings.pausedReason ? ` — ${escapeHtml(settings.pausedReason)}` : ''}`
    : `▶️ <b>Live</b>`;

  return (
    `${state}\n\n` +
    `Queued: <b>${queued.count ?? 0}</b>\n` +
    `Published (24h): <b>${today.count ?? 0}</b>\n` +
    `Daily cap: <b>${settings.dailyPostCap ?? 'env default'}</b>\n` +
    `Paid lookups: <b>${settings.allowPaidLookup ? 'on' : 'off'}</b>\n\n` +
    (budget
      ? `Spend: $${budget.spentUsd.toFixed(3)} / $${budget.capUsd.toFixed(2)} (${budget.pctUsed}%)`
      : `Spend: unavailable`)
  );
}

async function renderQueue(): Promise<string> {
  const supa = getSupabaseAdmin();
  const { data } = await supa
    .from('social_posts')
    .select('id, kind, body, scheduled_at')
    .eq('status', 'queued')
    .not('scheduled_at', 'is', null)
    .order('scheduled_at', { ascending: true })
    .limit(6);

  if (!data?.length) return `Queue is empty. The planner runs at 05:00 UTC.`;

  const lines = data.map((p: any) => {
    const when = new Date(p.scheduled_at).toLocaleString('en-NG', {
      weekday: 'short', hour: '2-digit', minute: '2-digit',
      timeZone: 'Africa/Lagos', hour12: false,
    });
    return (
      `<b>#${p.id}</b> · ${when} WAT · ${p.kind}\n` +
      `<i>${escapeHtml(String(p.body).slice(0, 160))}</i>`
    );
  });

  return `<b>Next up</b>\n\n${lines.join('\n\n')}\n\n<code>/skip ID</code> to cancel one.`;
}

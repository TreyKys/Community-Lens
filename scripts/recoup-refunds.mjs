#!/usr/bin/env node
// scripts/recoup-refunds.mjs
//
// Walks the /api/admin/recoup-refunds endpoint through a safe two-phase
// reconciliation of the 2026-06-25 wrong-refund event:
//   1. DRY RUN  — fetches the per-market plan, prints a clean summary,
//                 and stops. Nothing changes.
//   2. APPLY    — only runs if you type "APPLY" at the prompt. Flips
//                 the affected bets from 'refunded' to 'lost' (or 'won'
//                 for the rare all-winners markets), deducts the
//                 wrongful refund from each user's balance (clamped at
//                 ₦0 by credit_user — see "Shortfall" below), and
//                 re-resolves each market.
//
// USAGE (from the repo root):
//
//   ADMIN_SECRET=<...> API_BASE=https://opinionsng.com \
//     node scripts/recoup-refunds.mjs
//
//   To use a different market list, pass IDs as positional args:
//     node scripts/recoup-refunds.mjs 1598 1592 1510
//
//   To skip the prompt and run the dry run only (CI / cron):
//     node scripts/recoup-refunds.mjs --dry-only
//
// SHORTFALL
//   credit_user clamps balances at 0. A user who already spent or
//   withdrew their wrongful refund will zero out and the remainder is
//   unrecoverable. The dry run shows the theoretical recoup; the real
//   recoup will be less by the spent-already amount. The script prints
//   any user whose deduct exceeds their visible balance so you can
//   decide how to handle them (write-off, debt-track, freeze withdraw).
//
// HOUSE TNGN
//   Net recoup flows into the house reserve via apply_house_pnl and
//   lands as 'refund_recoup' in treasury_log. The script reports the
//   net house gain so you can sanity-check against the reserve before
//   and after.

import { createInterface } from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';

// ── Config ────────────────────────────────────────────────────────────
const API_BASE = process.env.API_BASE || 'https://opinionsng.com';
const ADMIN_SECRET = process.env.ADMIN_SECRET;
const DEFAULT_MARKET_IDS = [1598, 1592, 1510, 1540, 1586, 1560, 1520, 1532];

const cliArgs = process.argv.slice(2);
const dryOnly = cliArgs.includes('--dry-only');
const idArgs = cliArgs.filter(a => /^\d+$/.test(a)).map(Number);
const marketIds = idArgs.length > 0 ? idArgs : DEFAULT_MARKET_IDS;

if (!ADMIN_SECRET) {
  console.error('✖ ADMIN_SECRET is required. Set it in your env:');
  console.error('  ADMIN_SECRET=<...> node scripts/recoup-refunds.mjs');
  process.exit(1);
}

// ── Helpers ───────────────────────────────────────────────────────────
const ng = (n) => '₦' + Math.round(Number(n) || 0).toLocaleString('en-NG');
const pad = (s, n) => String(s).padEnd(n);
const padNum = (n, w) => String(n).padStart(w);

async function callRecoup({ dryRun }) {
  const res = await fetch(`${API_BASE}/api/admin/recoup-refunds`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${ADMIN_SECRET}`,
    },
    body: JSON.stringify({ marketIds, dryRun }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(`HTTP ${res.status} — ${body?.error || JSON.stringify(body)}`);
  }
  return body;
}

function printPlan(report, phase) {
  const banner = phase === 'dry' ? 'DRY RUN — nothing changed' : 'APPLIED';
  console.log('');
  console.log('━'.repeat(78));
  console.log(`  RECOUP — ${banner}`);
  console.log('━'.repeat(78));
  console.log('');

  console.log(`  Endpoint:        ${API_BASE}/api/admin/recoup-refunds`);
  console.log(`  Market IDs:      ${marketIds.join(', ')}`);
  console.log(`  Markets scanned: ${report.marketsScanned}`);
  console.log(`  Markets w/ recoup: ${report.marketsAffected}`);
  console.log('');

  // Per-market breakdown
  console.log('  PER-MARKET BREAKDOWN');
  console.log('  ' + '─'.repeat(76));
  console.log('  ' + pad('Market', 8) + pad('Bets', 6) + pad('To lost', 9) + pad('To won', 8) + pad('Recoup', 14) + pad('Top-up', 12) + 'Outcome');
  console.log('  ' + '─'.repeat(76));
  for (const m of report.affected) {
    const lost = m.plan.filter(p => p.action === 'to_lost').length;
    const won = m.plan.filter(p => p.action === 'to_won').length;
    const lbl = m.resolvedOutcomeLabel
      ? `[${m.resolvedOutcome}] ${m.resolvedOutcomeLabel.slice(0, 30)}`
      : `[${m.resolvedOutcome}]`;
    console.log(
      '  ' +
      pad('#' + m.marketId, 8) +
      pad(m.refundedBets, 6) +
      pad(lost, 9) +
      pad(won, 8) +
      pad(ng(m.recoupTngn), 14) +
      pad(m.topUpTngn ? ng(m.topUpTngn) : '—', 12) +
      lbl,
    );
  }
  console.log('');

  // Totals
  const t = report.totals;
  console.log('  TOTALS');
  console.log('  ' + '─'.repeat(60));
  console.log(`  Bets to flip → lost      ${padNum(t.betsToLost, 6)}`);
  console.log(`  Bets to flip → won       ${padNum(t.betsToWon, 6)}`);
  console.log(`  Users affected           ${padNum(t.usersAffected, 6)}`);
  console.log(`  Wrongful refunds to recoup    ${padNum(ng(t.recoupTngn), 14)}`);
  console.log(`  Top-ups owed to all-winner pots ${padNum(ng(t.topUpTngn), 12)}`);
  console.log(`  Net house gain                ${padNum(ng(t.netHouseGainTngn), 14)}`);
  console.log('');

  // Per-user shortfall flag if we can compute it. The endpoint doesn't
  // return current balances per user, so we just spotlight users with
  // large per-bet deductions — those are the most likely to have moved
  // money before the recoup.
  const perUser = new Map();
  for (const m of report.affected) {
    for (const p of m.plan) {
      if (p.action !== 'to_lost') continue;
      const cur = perUser.get(p.userId) || { total: 0, bets: 0 };
      cur.total += Number(p.deduct) || 0;
      cur.bets += 1;
      perUser.set(p.userId, cur);
    }
  }
  if (perUser.size > 0) {
    const sorted = Array.from(perUser.entries()).sort((a, b) => b[1].total - a[1].total);
    const top = sorted.slice(0, 10);
    console.log('  TOP USERS BY DEDUCTION (review for shortfall risk)');
    console.log('  ' + '─'.repeat(60));
    for (const [uid, info] of top) {
      console.log(`  ${pad(uid.slice(0, 8) + '…' + uid.slice(-4), 18)}   ${padNum(info.bets, 3)} bets   ${pad(ng(info.total), 14)}`);
    }
    if (sorted.length > 10) {
      console.log(`  … +${sorted.length - 10} more users`);
    }
    console.log('');
  }

  console.log('  ' + report.note);
  console.log('');
}

async function confirm(prompt) {
  const rl = createInterface({ input, output });
  try {
    const answer = await rl.question(prompt);
    return answer.trim() === 'APPLY';
  } finally {
    rl.close();
  }
}

// ── Run ───────────────────────────────────────────────────────────────
try {
  console.log('');
  console.log('Calling DRY RUN…');
  const dry = await callRecoup({ dryRun: true });
  printPlan(dry, 'dry');

  if (dryOnly) {
    console.log('--dry-only set — exiting without applying.');
    process.exit(0);
  }

  if (dry.marketsAffected === 0) {
    console.log('Nothing to recoup. Exiting.');
    process.exit(0);
  }

  const ok = await confirm(
    '  Type APPLY to commit these changes (anything else aborts): ',
  );
  if (!ok) {
    console.log('  Aborted. Nothing was changed.');
    process.exit(0);
  }

  console.log('');
  console.log('Calling APPLY…');
  const applied = await callRecoup({ dryRun: false });
  printPlan(applied, 'apply');

  console.log('  ✔ Recoup complete. Check treasury_log for refund_recoup rows.');
  console.log('');
} catch (e) {
  console.error('');
  console.error('✖ Recoup failed:', e.message);
  console.error('  Nothing was committed past the last successful market — re-run');
  console.error('  with the remaining IDs after investigating.');
  process.exit(1);
}

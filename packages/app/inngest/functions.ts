import { inngest } from './client';
import { createClient } from '@supabase/supabase-js';

function getSupabaseAdmin() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!
  );
}

function getBaseUrl() {
  return process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000';
}

// ── 1. MARKET LOCK CRON ────────────────────────────────────────────────────
// Runs every 5 minutes. Finds markets whose closes_at has passed
// and locks them — computing and committing the Merkle root.
export const marketLockCron = inngest.createFunction(
  { id: 'market-lock-cron', name: 'Market Lock Cron' },
  { cron: '*/5 * * * *' },
  async ({ step }) => {
    const supabaseAdmin = getSupabaseAdmin();

    // Find all open markets that have passed their close time
    const { data: marketsToLock } = await supabaseAdmin
      .from('markets')
      .select('id, title, closes_at')
      .eq('status', 'open')
      .lt('closes_at', new Date().toISOString());

    if (!marketsToLock || marketsToLock.length === 0) {
      return { locked: 0 };
    }

    const results = [];

    for (const market of marketsToLock) {
      const result = await step.run(`lock-market-${market.id}`, async () => {
        const res = await fetch(`${getBaseUrl()}/api/markets/lock`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-cron-secret': process.env.CRON_SECRET!,
          },
          body: JSON.stringify({ marketId: market.id }),
        });

        const data = await res.json();

        if (!res.ok) {
          console.error(`Failed to lock market ${market.id}:`, data.error);
          return { marketId: market.id, success: false, error: data.error };
        }

        console.log(`Locked market ${market.id}: ${market.title} (${data.betCount} bets, root: ${data.merkleRoot?.slice(0, 16)}...)`);
        return { marketId: market.id, success: true, betCount: data.betCount };
      });

      results.push(result);
    }

    return { locked: results.filter(r => r.success).length, results };
  }
);

// ── 2. ORACLE WORKER ───────────────────────────────────────────────────────
// Runs every 5 minutes. Finds locked sports markets with a fixture_id,
// checks the football-data.org API for a FINISHED result, and resolves them.
export const oracleWorker = inngest.createFunction(
  { id: 'oracle-worker', name: 'Football Oracle Worker' },
  { cron: '*/5 * * * *' },
  async ({ step }) => {
    const supabaseAdmin = getSupabaseAdmin();
    const apiKey = process.env.FOOTBALL_DATA_API_KEY;

    if (!apiKey) {
      console.warn('[Oracle] FOOTBALL_DATA_API_KEY not set — skipping');
      return { resolved: 0 };
    }

    // Find locked sports markets with a fixture_id
    // closes_at + 2 hours minimum to give the match time to finish
    const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();

    const { data: marketsToResolve } = await supabaseAdmin
      .from('markets')
      .select('id, title, fixture_id, options, resolution_attempts')
      .eq('status', 'locked')
      .eq('category', 'sports')
      .not('fixture_id', 'is', null)
      .lt('closes_at', twoHoursAgo);

    if (!marketsToResolve || marketsToResolve.length === 0) {
      return { resolved: 0 };
    }

    const results = [];

    for (const market of marketsToResolve) {
      const result = await step.run(`oracle-resolve-${market.id}`, async () => {
        try {
          // Check resolution attempts — alert admin after 48h of trying
          const attempts = market.resolution_attempts || 0;
          if (attempts > 576) { // 576 × 5min = 48 hours
            // Alert admin
            Promise.resolve(
              supabaseAdmin.from('notifications').insert({
                user_id: null, // admin alert
                type: 'admin_alert',
                message: `Market ${market.id} (${market.title}) has failed to resolve after 48 hours. Manual intervention required.`,
              })
            ).catch(() => {});
            return { marketId: market.id, success: false, reason: 'max_attempts_exceeded' };
          }

          // Increment attempt counter
          await supabaseAdmin
            .from('markets')
            .update({ resolution_attempts: attempts + 1 })
            .eq('id', market.id);

          // Fetch match result from football-data.org
          const apiRes = await fetch(
            `https://api.football-data.org/v4/matches/${market.fixture_id}`,
            { headers: { 'X-Auth-Token': apiKey } }
          );

          if (!apiRes.ok) {
            console.warn(`[Oracle] API error for fixture ${market.fixture_id}: ${apiRes.status}`);
            return { marketId: market.id, success: false, reason: 'api_error' };
          }

          const matchData = await apiRes.json();

          if (matchData.status !== 'FINISHED') {
            // Match still in progress or postponed
            return { marketId: market.id, success: false, reason: `match_status_${matchData.status}` };
          }

          // Map result to outcome index
          // Market options are always: [0] = Home Win, [1] = Draw, [2] = Away Win
          const outcomeMap: Record<string, number> = {
            HOME_TEAM: 0,
            DRAW: 1,
            AWAY_TEAM: 2,
          };

          const winner = matchData.score?.winner;
          if (!winner || outcomeMap[winner] === undefined) {
            console.warn(`[Oracle] Unexpected winner value: ${winner} for market ${market.id}`);
            return { marketId: market.id, success: false, reason: `unknown_winner_${winner}` };
          }

          const winningOutcomeIndex = outcomeMap[winner];

          // Call resolve endpoint
          const resolveRes = await fetch(`${getBaseUrl()}/api/markets/resolve`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'x-cron-secret': process.env.CRON_SECRET!,
            },
            body: JSON.stringify({ marketId: market.id, winningOutcomeIndex }),
          });

          const resolveData = await resolveRes.json();

          if (!resolveRes.ok) {
            console.error(`[Oracle] Failed to resolve market ${market.id}:`, resolveData.error);
            return { marketId: market.id, success: false, error: resolveData.error };
          }

          console.log(`[Oracle] Resolved market ${market.id}: outcome ${winningOutcomeIndex} (${winner}), ${resolveData.winnersCount} winners`);
          return { marketId: market.id, success: true, outcome: winningOutcomeIndex, winnersCount: resolveData.winnersCount };

        } catch (err: any) {
          console.error(`[Oracle] Exception for market ${market.id}:`, err.message);
          return { marketId: market.id, success: false, error: err.message };
        }
      });

      results.push(result);
    }

    return {
      resolved: results.filter(r => r.success).length,
      checked: results.length,
      results,
    };
  }
);

// ── 3. WEEKLY HEARTBEAT ────────────────────────────────────────────────────
// Fires every Sunday at midnight UTC.
// Publishes the on-chain heartbeat to reset the 30-day escape hatch clock.
export const weeklyHeartbeat = inngest.createFunction(
  { id: 'weekly-heartbeat', name: 'Weekly Escape Hatch Heartbeat' },
  { cron: '0 0 * * 0' }, // Every Sunday at midnight UTC
  async ({ step }) => {
    await step.run('fire-heartbeat', async () => {
      const res = await fetch(`${getBaseUrl()}/api/admin/heartbeat`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-cron-secret': process.env.CRON_SECRET!,
        },
      });

      const data = await res.json();
      if (!res.ok) throw new Error(`Heartbeat failed: ${data.error}`);

      console.log('[Heartbeat] Weekly heartbeat fired successfully');
      return { success: true };
    });
  }
);

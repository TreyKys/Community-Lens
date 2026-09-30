import type { SupabaseClient } from '@supabase/supabase-js';

// Every admin_alert insert used to be unconditional — a persistent
// condition (a market stuck past its resolution-attempt ceiling, a
// trading-health check that's been critical for hours) re-alerted on
// EVERY cron tick that found it still true, forever, until a human
// fixed the underlying thing. For a job running every 5 minutes,
// that's 288 identical rows a day from a SINGLE unresolved issue —
// real, continuous notification-table write load around the clock
// regardless of any user traffic, and it drowned out alerts that
// actually needed attention (see the mechanic/heartbeat findings from
// earlier this session).
//
// This checks for a recent alert sharing the same `key` before
// inserting a new one. Same underlying problem still gets surfaced —
// once per cooldown window, not once per tick.
export async function sendAdminAlert(
  supabase: SupabaseClient,
  message: string,
  key: string,
  cooldownHours: number,
): Promise<void> {
  const since = new Date(Date.now() - cooldownHours * 60 * 60 * 1000).toISOString();
  const { count } = await supabase
    .from('notifications')
    .select('id', { count: 'exact', head: true })
    .eq('type', 'admin_alert')
    .eq('alert_key', key)
    .gte('created_at', since);
  if ((count ?? 0) > 0) return; // already alerted about this within the window — stay quiet

  await supabase.from('notifications').insert({
    user_id: null,
    type: 'admin_alert',
    message,
    alert_key: key,
  });
}

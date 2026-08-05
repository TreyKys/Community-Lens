// Runtime control for the social pipeline.
//
// This pipeline spends real money on a schedule with nobody watching.
// "Stop it" therefore has to be reachable from a phone in thirty
// seconds — not an SSH session, not a redeploy, not a git push. These
// settings live in one row so a Telegram command can change behaviour
// on the next cron tick.
//
// Reads fail CLOSED in the direction of not spending: if the settings
// row cannot be read, we treat publishing as paused. An unreachable
// database is exactly when you least want an unattended job deciding
// on its own that everything is probably fine.

import { getSupabaseAdmin } from '@/lib/oracle';

export type SocialSettings = {
  publishingPaused: boolean;
  pausedReason: string | null;
  dailyPostCap: number | null;
  allowPaidLookup: boolean;
};

const SAFE_DEFAULT: SocialSettings = {
  publishingPaused: true,
  pausedReason: 'settings unavailable — failing closed',
  dailyPostCap: null,
  allowPaidLookup: false,
};

export async function getSettings(): Promise<SocialSettings> {
  try {
    const supa = getSupabaseAdmin();
    const { data, error } = await supa
      .from('social_settings')
      .select('publishing_paused, paused_reason, daily_post_cap, allow_paid_lookup')
      .eq('id', 1)
      .maybeSingle();

    if (error || !data) return SAFE_DEFAULT;

    return {
      publishingPaused: Boolean(data.publishing_paused),
      pausedReason: (data.paused_reason as string) ?? null,
      dailyPostCap:
        data.daily_post_cap === null || data.daily_post_cap === undefined
          ? null
          : Number(data.daily_post_cap),
      allowPaidLookup: Boolean(data.allow_paid_lookup),
    };
  } catch {
    return SAFE_DEFAULT;
  }
}

export async function setPaused(paused: boolean, reason?: string): Promise<void> {
  const supa = getSupabaseAdmin();
  await supa
    .from('social_settings')
    .update({
      publishing_paused: paused,
      paused_reason: paused ? (reason ?? 'paused from Telegram') : null,
      paused_at: paused ? new Date().toISOString() : null,
    })
    .eq('id', 1);
}

/** Null clears the override and falls back to SOCIAL_DAILY_POST_CAP. */
export async function setDailyCap(cap: number | null): Promise<void> {
  const supa = getSupabaseAdmin();
  await supa.from('social_settings').update({ daily_post_cap: cap }).eq('id', 1);
}

export async function setAllowPaidLookup(allow: boolean): Promise<void> {
  const supa = getSupabaseAdmin();
  await supa.from('social_settings').update({ allow_paid_lookup: allow }).eq('id', 1);
}

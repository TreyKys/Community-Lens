import type { SupabaseClient } from '@supabase/supabase-js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Several admin screens ask a human to identify a user — themselves as a
// resolver, another admin as a confirmer, a real user as a market's
// creator — and previously only accepted that user's raw UUID, typed or
// pasted by hand. An admin has someone's email on hand far more often than
// their UUID, and there's no safety reason to refuse it: this resolves the
// same identity either way before it reaches an RPC that expects a UUID.
// Matches the convenience already used by admin/users/[id], admin/credits,
// admin/email/welcome and admin/apply-bonus-split-correction.
export async function resolveAdminUserId(
  supabase: SupabaseClient,
  lookup: string | null | undefined,
): Promise<string | null> {
  const trimmed = (lookup || '').trim();
  if (!trimmed) return null;
  if (UUID_RE.test(trimmed)) return trimmed;

  const { data } = await supabase
    .from('users')
    .select('id')
    .eq('email', trimmed.toLowerCase())
    .maybeSingle();
  return data?.id || null;
}

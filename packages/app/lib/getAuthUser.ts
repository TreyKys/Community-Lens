import type { SupabaseClient, User } from '@supabase/supabase-js';

/**
 * Resolve the Supabase user behind a request's `Authorization: Bearer <token>`
 * header, or null if the header is missing or the token doesn't validate.
 *
 * Previously copy-pasted verbatim into five API routes. Centralised so the auth
 * behaviour (and any future hardening) has exactly one definition.
 *
 * Pass the route's service-role client as `db` — the helper stays client-agnostic
 * rather than constructing its own, so routes keep a single Supabase instance.
 */
export async function getAuthUser(db: SupabaseClient, request: Request): Promise<User | null> {
  const authHeader = request.headers.get('Authorization');
  if (!authHeader) return null;
  const token = authHeader.replace('Bearer ', '');
  const { data: { user }, error } = await db.auth.getUser(token);
  if (error || !user) return null;
  return user;
}

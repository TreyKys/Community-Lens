import { NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';

export const dynamic = 'force-dynamic';

const supabaseAdmin = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
);

// POST /api/push/rotate — the service worker's pushsubscriptionchange handler.
//
// THE ONE UNAUTHENTICATED WRITE IN THIS FEATURE, and worth being explicit
// about why. A service worker cannot read the Supabase session: it lives in
// localStorage and workers have no access to it. So when a push service
// retires a subscription while the app is closed, there is no bearer token to
// send and the choice is between an unauthenticated call and a device that
// silently stops receiving anything.
//
// It authenticates by POSSESSION instead. The caller must present the OLD
// subscription's endpoint AND its auth secret. Anyone holding both can already
// decrypt every push we send that device, so requiring them concedes nothing;
// a caller who has merely guessed an endpoint cannot redirect a stranger's
// notifications to a device they control.
//
// Three further limits keep the blast radius at zero:
//   * it MOVES an existing row, never creates one, so it cannot register a
//     device against a user who never opted in;
//   * it never reads or returns the user_id, so it cannot be used as an oracle
//     for who owns an endpoint;
//   * every failure returns the same 204, so it says nothing about whether a
//     given endpoint exists.

export async function POST(request: Request) {
  const body = await request.json().catch(() => ({} as any));
  const oldEndpoint = String(body?.oldEndpoint || '');
  const oldAuth = String(body?.oldAuth || '');
  const endpoint = String(body?.subscription?.endpoint || '');
  const p256dh = String(body?.subscription?.keys?.p256dh || '');
  const auth = String(body?.subscription?.keys?.auth || '');

  const silent = () => new NextResponse(null, { status: 204 });

  if (!oldEndpoint || !oldAuth || !endpoint || !p256dh || !auth) return silent();
  if (!/^https:\/\//i.test(endpoint)) return silent();

  // The proof: the row must exist AND its stored auth secret must match.
  const { data: row } = await supabaseAdmin
    .from('push_subscriptions')
    .select('id')
    .eq('endpoint', oldEndpoint)
    .eq('auth', oldAuth)
    .maybeSingle();

  if (!row) return silent();

  // If the browser rotated to an endpoint that already has a row — the same
  // device re-registering after we thought it was gone — drop the stale one
  // rather than colliding with the unique index.
  if (endpoint !== oldEndpoint) {
    await supabaseAdmin.from('push_subscriptions').delete().eq('endpoint', endpoint);
  }

  await supabaseAdmin
    .from('push_subscriptions')
    .update({
      endpoint,
      p256dh,
      auth,
      failed_at: null,
      fail_reason: null,
      last_used_at: new Date().toISOString(),
    })
    .eq('id', row.id);

  return silent();
}

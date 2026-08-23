import { NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { getAuthUser } from '@/lib/getAuthUser';
import { pushConfigured } from '@/lib/push';

export const dynamic = 'force-dynamic';

const supabaseAdmin = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
);

// POST   /api/push/subscribe — register this browser for notifications
// DELETE /api/push/subscribe — stop sending to it
// GET    /api/push/subscribe — is push even switched on for this deployment?
//
// The client calls POST on EVERY visit where permission is already granted,
// not just the first. Push subscriptions expire and rotate on the browser's
// own schedule, and a device that quietly went stale is indistinguishable from
// one that never subscribed. Re-upserting on each visit is one cheap write
// that keeps the table honest.

// GET tells the client whether to bother asking. Returns the public key so the
// browser can subscribe; that key is public by design — it is what identifies
// this server to the push service, and a subscription made with it can only be
// pushed to by whoever holds the private half.
export async function GET() {
  return NextResponse.json(
    {
      configured: pushConfigured,
      publicKey: process.env.VAPID_PUBLIC_KEY || null,
    },
    { headers: { 'Cache-Control': 'no-store' } },
  );
}

type SubJson = {
  endpoint?: string;
  keys?: { p256dh?: string; auth?: string };
};

export async function POST(request: Request) {
  const user = await getAuthUser(supabaseAdmin, request);
  if (!user) return NextResponse.json({ error: 'Please sign in' }, { status: 401 });

  const body = await request.json().catch(() => ({} as any));
  const sub: SubJson = body?.subscription || {};
  const endpoint = String(sub.endpoint || '');
  const p256dh = String(sub.keys?.p256dh || '');
  const auth = String(sub.keys?.auth || '');

  if (!endpoint || !p256dh || !auth) {
    return NextResponse.json({ error: 'Incomplete subscription' }, { status: 400 });
  }
  // The endpoint is a URL we will later make requests to. Refusing anything
  // that is not https keeps this from being a way to point the sweeper at
  // arbitrary internal addresses.
  if (!/^https:\/\//i.test(endpoint)) {
    return NextResponse.json({ error: 'Invalid endpoint' }, { status: 400 });
  }

  // ON CONFLICT (endpoint) rather than (user_id): the endpoint is the identity
  // of a device. Keying on user_id would let one person register only a single
  // device, and keying on neither would accumulate a new row every visit until
  // one settlement sent someone forty copies of itself.
  //
  // user_id is included in the update so a shared or handed-down device
  // follows whoever signed in last rather than notifying the previous owner.
  const { error } = await supabaseAdmin
    .from('push_subscriptions')
    .upsert(
      {
        user_id: user.id,
        endpoint,
        p256dh,
        auth,
        user_agent: (request.headers.get('user-agent') || '').slice(0, 300),
        last_used_at: new Date().toISOString(),
        // Clearing the failure marks: this is the same browser telling us it
        // works now, which outranks whatever the push service said last week.
        failed_at: null,
        fail_reason: null,
      },
      { onConflict: 'endpoint' },
    );

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true });
}

export async function DELETE(request: Request) {
  const user = await getAuthUser(supabaseAdmin, request);
  if (!user) return NextResponse.json({ error: 'Please sign in' }, { status: 401 });

  const body = await request.json().catch(() => ({} as any));
  const endpoint = String(body?.endpoint || '');
  if (!endpoint) return NextResponse.json({ error: 'Missing endpoint' }, { status: 400 });

  // Scoped to the caller's own rows: without eq('user_id') this would delete
  // anyone's subscription for the price of knowing its endpoint.
  const { error } = await supabaseAdmin
    .from('push_subscriptions')
    .delete()
    .eq('endpoint', endpoint)
    .eq('user_id', user.id);

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true });
}

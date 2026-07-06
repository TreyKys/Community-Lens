import { NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { isAdminRequest } from '@/lib/adminAuth';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

const supabaseAdmin = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
);

// GET  /api/mechanic/state         — read pause flag + last-run info
// POST /api/mechanic/state         — { action: 'pause' | 'unpause', reason? }
export async function GET(request: Request) {
  if (!isAdminRequest(request)) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const { data, error } = await supabaseAdmin.from('mechanic_state').select('*').eq('id', 1).maybeSingle();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ state: data }, { headers: { 'Cache-Control': 'no-store' } });
}

export async function POST(request: Request) {
  if (!isAdminRequest(request)) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  let body: any;
  try { body = await request.json(); }
  catch { return NextResponse.json({ error: 'Malformed body' }, { status: 400 }); }
  const action = body?.action;
  const reason = typeof body?.reason === 'string' ? body.reason : null;

  if (action === 'pause') {
    await supabaseAdmin.from('mechanic_state').update({
      paused: true,
      pause_reason: reason || 'Paused by admin',
      paused_at: new Date().toISOString(),
      paused_by: 'admin',
      updated_at: new Date().toISOString(),
    }).eq('id', 1);
    return NextResponse.json({ ok: true, paused: true });
  }
  if (action === 'unpause') {
    await supabaseAdmin.from('mechanic_state').update({
      paused: false,
      pause_reason: null,
      paused_at: null,
      paused_by: null,
      updated_at: new Date().toISOString(),
    }).eq('id', 1);
    return NextResponse.json({ ok: true, paused: false });
  }
  return NextResponse.json({ error: "action must be 'pause' or 'unpause'" }, { status: 400 });
}

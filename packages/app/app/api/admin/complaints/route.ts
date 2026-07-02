import { NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { isAdminRequest } from '@/lib/adminAuth';

export const maxDuration = 60;
export const dynamic = 'force-dynamic';
export const revalidate = 0;
export const fetchCache = 'force-no-store';

const supabaseAdmin = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
);

const NO_CACHE = {
  'Cache-Control': 'no-store, no-cache, must-revalidate, max-age=0',
  'Pragma': 'no-cache',
};

// GET  /api/admin/complaints          — list, filterable by status/type
// POST /api/admin/complaints          — { complaintId, action, ... }
//     actions: 'reply' (writes notification), 'resolve', 'reopen',
//              'assign' (assigned_admin_id), 'transition' (arbitrary
//              status change with audit-trail-ready reason)
export async function GET(request: Request) {
  if (!isAdminRequest(request)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const url = new URL(request.url);
  const status = url.searchParams.get('status');
  const type = url.searchParams.get('type');
  const includeChildrenParam = url.searchParams.get('includeChildren');
  const includeChildren = includeChildrenParam === '1' || includeChildrenParam === 'true';
  const limit = Math.min(200, Math.max(1, Number(url.searchParams.get('limit')) || 50));

  // By default hide aggregation children — only surface parents.
  let q = supabaseAdmin
    .from('user_complaints')
    .select(`
      id, user_id, reference_code, type, description, status,
      ai_triage_category, ai_triage_confidence,
      mechanic_attempted, mechanic_result,
      assigned_admin_id, admin_response, admin_responded_at,
      aggregate_parent_id,
      related_bet_id, related_slip_id, related_market_id,
      context,
      created_at, resolved_at
    `)
    .order('created_at', { ascending: false })
    .limit(limit);
  if (status) q = q.eq('status', status);
  if (type) q = q.eq('type', type);
  if (!includeChildren) q = q.is('aggregate_parent_id', null);

  const { data: rows, error } = await q;
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  // For each parent row, count child complaints so /ops can render
  // "N users reporting" without a second round trip.
  const parentIds = (rows || []).map(r => r.id);
  let childCountsById: Record<string, number> = {};
  if (parentIds.length > 0) {
    const { data: children } = await supabaseAdmin
      .from('user_complaints')
      .select('aggregate_parent_id')
      .in('aggregate_parent_id', parentIds);
    for (const c of children || []) {
      const pid = c.aggregate_parent_id as string;
      childCountsById[pid] = (childCountsById[pid] || 0) + 1;
    }
  }

  // Attach user email/username for display.
  const userIds = Array.from(new Set((rows || []).map(r => r.user_id)));
  const { data: users } = userIds.length > 0
    ? await supabaseAdmin.from('users').select('id, email, username').in('id', userIds)
    : { data: [] as any[] };
  const usersById: Record<string, any> = Object.fromEntries((users || []).map(u => [u.id, u]));

  const enriched = (rows || []).map(r => ({
    ...r,
    user_email: usersById[r.user_id]?.email,
    user_username: usersById[r.user_id]?.username,
    aggregate_child_count: childCountsById[r.id] || 0,
  }));

  return NextResponse.json({ complaints: enriched }, { headers: NO_CACHE });
}

export async function POST(request: Request) {
  if (!isAdminRequest(request)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  let body: any;
  try { body = await request.json(); }
  catch { return NextResponse.json({ error: 'Malformed body' }, { status: 400 }); }

  const complaintId = String(body?.complaintId || '');
  const action = String(body?.action || '');
  if (!complaintId || !action) {
    return NextResponse.json({ error: 'complaintId + action required' }, { status: 400 });
  }

  const { data: complaint, error: cErr } = await supabaseAdmin
    .from('user_complaints')
    .select('id, user_id, reference_code, status')
    .eq('id', complaintId)
    .single();
  if (cErr || !complaint) return NextResponse.json({ error: 'Complaint not found' }, { status: 404 });

  // ── reply: write a notification to the user, mark responded. ─────
  if (action === 'reply') {
    const message = String(body?.message || '').trim();
    if (!message) return NextResponse.json({ error: 'message required' }, { status: 400 });
    if (message.length > 2000) return NextResponse.json({ error: 'message too long' }, { status: 400 });

    const now = new Date().toISOString();
    const nextStatus = body?.andResolve === true ? 'resolved' : 'admin_working';

    await supabaseAdmin.from('user_complaints').update({
      admin_response: message,
      admin_responded_at: now,
      status: nextStatus,
      ...(nextStatus === 'resolved' ? { resolved_at: now } : {}),
    }).eq('id', complaintId);

    // Notify user via the same notifications table the bell reads.
    await supabaseAdmin.from('notifications').insert({
      user_id: complaint.user_id,
      type: 'complaint_response',
      severity: 'info',
      category: 'complaint',
      reference_code: complaint.reference_code,
      message,
    });

    // Cascade the reply to every aggregation child too — each user
    // filed the same underlying issue, they should each hear back.
    const { data: kids } = await supabaseAdmin
      .from('user_complaints')
      .select('id, user_id, reference_code')
      .eq('aggregate_parent_id', complaintId);
    for (const k of kids || []) {
      await supabaseAdmin.from('user_complaints').update({
        admin_response: message,
        admin_responded_at: now,
        status: nextStatus,
        ...(nextStatus === 'resolved' ? { resolved_at: now } : {}),
      }).eq('id', k.id);
      await supabaseAdmin.from('notifications').insert({
        user_id: k.user_id,
        type: 'complaint_response',
        severity: 'info',
        category: 'complaint',
        reference_code: k.reference_code,
        message,
      });
    }
    return NextResponse.json({ ok: true, status: nextStatus, replied_to_children: (kids || []).length }, { headers: NO_CACHE });
  }

  // ── resolve without a message. ───────────────────────────────────
  if (action === 'resolve') {
    const now = new Date().toISOString();
    await supabaseAdmin.from('user_complaints')
      .update({ status: 'resolved', resolved_at: now })
      .in('id', [complaintId, ...(await getChildIds(complaintId))]);
    return NextResponse.json({ ok: true, status: 'resolved' }, { headers: NO_CACHE });
  }

  // ── reopen a resolved complaint. ──────────────────────────────────
  if (action === 'reopen') {
    await supabaseAdmin.from('user_complaints').update({
      status: 'admin_working',
      resolved_at: null,
    }).eq('id', complaintId);
    return NextResponse.json({ ok: true, status: 'admin_working' }, { headers: NO_CACHE });
  }

  // ── assign to an admin. ──────────────────────────────────────────
  if (action === 'assign') {
    const adminId = body?.adminId ? String(body.adminId) : null;
    await supabaseAdmin.from('user_complaints')
      .update({ assigned_admin_id: adminId, status: 'admin_working' })
      .eq('id', complaintId);
    return NextResponse.json({ ok: true }, { headers: NO_CACHE });
  }

  return NextResponse.json({ error: `Unknown action: ${action}` }, { status: 400 });
}

async function getChildIds(parentId: string): Promise<string[]> {
  const { data } = await supabaseAdmin
    .from('user_complaints')
    .select('id')
    .eq('aggregate_parent_id', parentId);
  return (data || []).map(d => d.id);
}

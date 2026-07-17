import { NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { isAdminRequest } from '@/lib/adminAuth';

export const dynamic = 'force-dynamic';

const supabaseAdmin = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
);

// GET /api/admin/stuck-deposits  (admin-gated)
//
// Lists Squad deposits that are NOT completed and NOT abandoned — the ones a
// user might report as "paid but not credited". Each row carries the context
// an admin needs, plus a `reviewFlag` for the ambiguous 'crediting' half-state
// that must never be auto-credited. Admin re-verifies/credits a row via
// POST /api/squad/refresh with { reference }.

export async function GET(request: Request) {
  if (!isAdminRequest(request)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const { searchParams } = new URL(request.url);
  const days = Math.min(Math.max(Number(searchParams.get('days') || 7), 1), 90);
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();

  const { data: rows, error } = await supabaseAdmin
    .from('squad_transactions')
    .select('transaction_ref, user_id, amount_ngn, tngn_credited, status, created_at')
    .not('status', 'in', '("completed","abandoned")')
    .gte('created_at', since)
    .order('created_at', { ascending: false })
    .limit(200);

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  // Resolve handles for readability.
  const userIds = Array.from(new Set((rows || []).map(r => r.user_id).filter(Boolean)));
  const handleById: Record<string, string> = {};
  if (userIds.length > 0) {
    const { data: users } = await supabaseAdmin
      .from('users')
      .select('id, username, first_name')
      .in('id', userIds);
    for (const u of users || []) handleById[u.id] = u.username || u.first_name || 'user';
  }

  const deposits = (rows || []).map(r => ({
    reference: r.transaction_ref,
    userId: r.user_id,
    handle: r.user_id ? (handleById[r.user_id] || 'user') : '—',
    amountNgn: Number(r.amount_ngn || 0),
    tngnCredited: r.tngn_credited == null ? null : Number(r.tngn_credited),
    status: r.status,
    createdAt: r.created_at,
    // 'crediting' is the one ambiguous state — surface it, don't hide it.
    reviewFlag: r.status === 'crediting',
  }));

  const summary = {
    total: deposits.length,
    crediting: deposits.filter(d => d.status === 'crediting').length,
    failedBalanceUpdate: deposits.filter(d => d.status === 'failed_balance_update').length,
    other: deposits.filter(d => d.status !== 'crediting' && d.status !== 'failed_balance_update').length,
  };

  return NextResponse.json({ deposits, summary }, { headers: { 'Cache-Control': 'no-store' } });
}

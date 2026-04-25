import { NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { isAdminRequest } from '@/lib/adminAuth';

function supabaseAdmin() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!
  );
}

/**
 * GET /api/admin/users
 * Query params:
 *   - search: optional substring matched against email / username
 *   - sort: tngn_balance | bonus_balance | lifetime_credits | last_active (default last_active)
 *   - dir: asc | desc (default desc)
 *   - page: 1-indexed
 *   - pageSize: default 25, max 100
 *
 * Returns each user's wallet + bonus balance + lifetime credits issued (sum of
 * positive treasury_log entries tagged manual_credit / first_bet_insurance / deposit_bet_credit).
 */
export async function GET(request: Request) {
  if (!isAdminRequest(request)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const url = new URL(request.url);
  const search = url.searchParams.get('search')?.trim() || '';
  const sort = url.searchParams.get('sort') || 'last_active';
  const dir = url.searchParams.get('dir') === 'asc' ? 'asc' : 'desc';
  const page = Math.max(1, Number(url.searchParams.get('page') || 1));
  const pageSize = Math.min(100, Math.max(1, Number(url.searchParams.get('pageSize') || 25)));

  const db = supabaseAdmin();

  let query = db
    .from('users')
    .select('id, email, username, tngn_balance, bonus_balance, created_at', { count: 'exact' });

  if (search) {
    const safe = search.replace(/[%_]/g, ''); // strip wildcards from raw input
    query = query.or(`email.ilike.%${safe}%,username.ilike.%${safe}%`);
  }

  const sortableColumns: Record<string, string> = {
    tngn_balance: 'tngn_balance',
    bonus_balance: 'bonus_balance',
    last_active: 'created_at', // proxy until we add a real last_active column
    email: 'email',
  };
  const sortColumn = sortableColumns[sort] || 'created_at';

  const from = (page - 1) * pageSize;
  const to = from + pageSize - 1;

  const { data: users, count, error } = await query
    .order(sortColumn, { ascending: dir === 'asc' })
    .range(from, to);

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  // Pull lifetime credits for the current page in a single grouped query.
  const userIds = (users || []).map((u) => u.id);
  let creditsByUser: Record<string, number> = {};
  if (userIds.length) {
    const { data: creditRows } = await db
      .from('treasury_log')
      .select('user_id, amount_tngn, type')
      .in('user_id', userIds)
      .in('type', ['manual_credit', 'first_bet_insurance']);
    for (const row of creditRows || []) {
      const uid = row.user_id as string;
      creditsByUser[uid] = (creditsByUser[uid] || 0) + Number(row.amount_tngn || 0);
    }
  }

  const rows = (users || []).map((u) => ({
    id: u.id,
    email: u.email || null,
    username: u.username || null,
    tngn_balance: Number(u.tngn_balance || 0),
    bonus_balance: Number(u.bonus_balance || 0),
    lifetime_credits: creditsByUser[u.id] || 0,
    created_at: u.created_at || null,
  }));

  // If sorting by lifetime_credits, we have to sort in memory since it's a derived field.
  if (sort === 'lifetime_credits') {
    rows.sort((a, b) => (dir === 'asc' ? a.lifetime_credits - b.lifetime_credits : b.lifetime_credits - a.lifetime_credits));
  }

  return NextResponse.json({
    users: rows,
    total: count ?? rows.length,
    page,
    pageSize,
  });
}

import { NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { isAdminRequest } from '@/lib/adminAuth';
import { getAuthUser } from '@/lib/getAuthUser';
import { resolveAdminUserId } from '@/lib/resolveAdminUserId';

export const dynamic = 'force-dynamic';

const supabaseAdmin = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
);

// POST /api/admin/open-markets/add-outcome
//
// Adds a new outcome to a LIVE Open Market — "a new candidate enters the
// race" — without closing the book and losing every existing trader's
// position. All the actual math and safety checks (LMSR repricing, the
// fleet exposure cap, the creator-accrual invariant guard) live in
// add_open_market_outcome; this route only resolves who's asking and passes
// the request through. Defaults to a dry run, same convention as
// open-markets/resolve, so an admin sees the resulting prices before
// committing to a change that reshapes the book.
export async function POST(request: Request) {
  if (!isAdminRequest(request)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const body = await request.json().catch(() => ({} as any));
  const marketId = String(body?.marketId || '');
  const label = String(body?.label || '');
  const initialPricePct = Number(body?.initialPricePct);
  const reason = body?.reason ? String(body.reason) : null;
  const dryRun = body?.dryRun !== false;

  if (!marketId) return NextResponse.json({ error: 'Missing marketId' }, { status: 400 });
  if (!Number.isFinite(initialPricePct)) {
    return NextResponse.json({ error: 'Missing or invalid initialPricePct' }, { status: 400 });
  }

  const sessionUser = await getAuthUser(supabaseAdmin, request);
  const adminId = sessionUser?.id
    || (await resolveAdminUserId(supabaseAdmin, body?.adminId))
    || process.env.ADMIN_REVIEWER_USER_ID
    || null;

  const { data, error } = await supabaseAdmin.rpc('add_open_market_outcome', {
    p_market_id: marketId,
    p_label: label,
    p_initial_price: initialPricePct / 100,
    p_admin_id: adminId,
    p_reason: reason,
    p_dry_run: dryRun,
  });
  if (error) return NextResponse.json({ error: error.message }, { status: 400 });

  const row = Array.isArray(data) ? data[0] : data;
  if (!row?.applied && row?.reason !== 'dry_run') {
    return NextResponse.json({ error: row?.reason || 'Could not add outcome' }, { status: 400 });
  }

  return NextResponse.json({
    preview: row?.reason === 'dry_run',
    outcomeIdx: row?.outcome_idx,
    newPrices: (row?.new_prices || []).map((p: number) => Number(p)),
  });
}

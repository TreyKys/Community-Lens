import { NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { isAdminRequest } from '@/lib/adminAuth';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function supabaseAdmin() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!
  );
}

// Recent manual_credit history for the admin Credits panel. Moved
// server-side so we could lock down treasury_log with RLS without
// breaking the panel — the table is no longer client-readable, but
// service-role queries (this route) still see everything.
export async function GET(request: Request) {
  if (!isAdminRequest(request)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  const db = supabaseAdmin();
  const { data, error } = await db
    .from('treasury_log')
    .select('amount_tngn, user_id, created_at, metadata')
    .eq('type', 'manual_credit')
    .order('created_at', { ascending: false })
    .limit(50);
  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
  return NextResponse.json({ history: data || [] });
}

export async function POST(request: Request) {
  try {
    if (!isAdminRequest(request)) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const { userLookup, amount, reason } = await request.json();
    const amt = Number(amount);
    if (!userLookup || !amt || amt <= 0) {
      return NextResponse.json({ error: 'userLookup and positive amount required' }, { status: 400 });
    }
    if (amt > 1_000_000) {
      return NextResponse.json({ error: 'Single issuance capped at ₦1,000,000' }, { status: 400 });
    }

    const db = supabaseAdmin();
    const lookup = String(userLookup).trim();

    let userQuery;
    if (UUID_RE.test(lookup)) {
      userQuery = db.from('users').select('id, email, bonus_balance').eq('id', lookup);
    } else {
      userQuery = db.from('users').select('id, email, bonus_balance').eq('email', lookup.toLowerCase());
    }

    const { data: user, error: userErr } = await userQuery.maybeSingle();
    if (userErr) return NextResponse.json({ error: userErr.message }, { status: 500 });
    if (!user) return NextResponse.json({ error: 'User not found' }, { status: 404 });

    // Credit atomically via credit_user (row-locked) instead of the old
    // read-then-write, which raced with any concurrent credit on the
    // same user (e.g. a bet settling at the same moment) and could drop
    // one of the two deltas.
    const { data: creditResult, error: updateErr } = await db
      .rpc('credit_user', {
        p_user_id: user.id,
        p_tngn_delta: 0,
        p_bonus_delta: amt,
      })
      .single<{ tngn_balance: number; bonus_balance: number }>();
    if (updateErr) return NextResponse.json({ error: updateErr.message }, { status: 500 });
    const newBonus = Number(creditResult?.bonus_balance ?? (user.bonus_balance || 0) + amt);

    await db.from('treasury_log').insert({
      type: 'manual_credit',
      amount_tngn: amt,
      user_id: user.id,
      created_at: new Date().toISOString(),
      metadata: { reason: reason || null },
    });

    try {
      await db.from('notifications').insert({
        user_id: user.id,
        type: 'credit_issued',
        message: `₦${amt.toLocaleString()} bonus credits added to your account. Use them on your next position.`,
        amount: amt,
      });
    } catch {
      // notifications table optional
    }

    return NextResponse.json({
      success: true,
      userId: user.id,
      email: user.email,
      newBonusBalance: newBonus,
    });
  } catch (error: any) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}

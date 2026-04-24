import { NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function supabaseAdmin() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!
  );
}

export async function POST(request: Request) {
  try {
    const auth = request.headers.get('Authorization');
    if (auth !== `Bearer ${process.env.ADMIN_SECRET}`) {
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

    const newBonus = (user.bonus_balance || 0) + amt;

    const { error: updateErr } = await db
      .from('users')
      .update({ bonus_balance: newBonus })
      .eq('id', user.id);
    if (updateErr) return NextResponse.json({ error: updateErr.message }, { status: 500 });

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

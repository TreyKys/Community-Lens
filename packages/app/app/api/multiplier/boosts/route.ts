import { NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';

const supabaseAdmin = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
);

// GET /api/multiplier/boosts
//
// Returns the user's current Boost balance, applying a daily recharge
// on read (recharge_boosts is a no-op if not yet eligible). Ensures the
// wallet exists (granting the signup Boosts on first call).
export async function GET(request: Request) {
  try {
    const authHeader = request.headers.get('Authorization');
    if (!authHeader) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

    const token = authHeader.replace('Bearer ', '');
    const { data: { user }, error: authError } = await supabaseAdmin.auth.getUser(token);
    if (authError || !user) return NextResponse.json({ error: 'Invalid session' }, { status: 401 });

    // ensure_boost_wallet (idempotent) then recharge (no-op if not due).
    // recharge_boosts calls ensure internally, so one call suffices.
    const { data: balance, error } = await supabaseAdmin
      .rpc('recharge_boosts', { p_user_id: user.id });

    if (error) {
      console.error('recharge_boosts failed:', error);
      return NextResponse.json({ error: 'Could not load Boosts' }, { status: 500 });
    }

    return NextResponse.json({ balance: Number(balance ?? 0) });
  } catch (e: any) {
    console.error('Boosts GET error:', e);
    return NextResponse.json({ error: 'Internal error' }, { status: 500 });
  }
}

// POST /api/multiplier/boosts  { quantity }
//
// Buy Boosts at ₦70 each. Deducts from balance, logs treasury boost_rake.
export async function POST(request: Request) {
  try {
    const authHeader = request.headers.get('Authorization');
    if (!authHeader) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

    const token = authHeader.replace('Bearer ', '');
    const { data: { user }, error: authError } = await supabaseAdmin.auth.getUser(token);
    if (authError || !user) return NextResponse.json({ error: 'Invalid session' }, { status: 401 });

    let body: any;
    try { body = await request.json(); }
    catch { return NextResponse.json({ error: 'Malformed request body' }, { status: 400 }); }

    const quantity = Math.floor(Number(body?.quantity));
    if (!Number.isInteger(quantity) || quantity < 1 || quantity > 20) {
      return NextResponse.json({ error: 'Quantity must be between 1 and 20' }, { status: 400 });
    }

    const { data, error } = await supabaseAdmin
      .rpc('purchase_boosts', { p_user_id: user.id, p_quantity: quantity })
      .single<{
        boosts_balance: number;
        new_tngn_balance: number;
        new_bonus_balance: number;
        cost_tngn: number;
      }>();

    if (error) {
      const msg = error.message || '';
      if (msg.includes('insufficient_balance')) {
        return NextResponse.json({ error: 'Not enough balance to buy Boosts. Top up first.' }, { status: 400 });
      }
      if (msg.includes('invalid_quantity')) {
        return NextResponse.json({ error: 'Invalid quantity' }, { status: 400 });
      }
      console.error('purchase_boosts failed:', error);
      return NextResponse.json({ error: 'Could not buy Boosts' }, { status: 500 });
    }
    if (!data) return NextResponse.json({ error: 'Could not buy Boosts' }, { status: 500 });

    return NextResponse.json({
      balance: Number(data.boosts_balance),
      cost: Number(data.cost_tngn),
      newBalance: Number(data.new_tngn_balance),
      newBonusBalance: Number(data.new_bonus_balance),
    });
  } catch (e: any) {
    console.error('Boosts POST error:', e);
    return NextResponse.json({ error: 'Internal error' }, { status: 500 });
  }
}

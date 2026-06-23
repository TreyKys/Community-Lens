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

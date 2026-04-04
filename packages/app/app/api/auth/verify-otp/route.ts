import { NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { deriveWalletAddress } from '@/lib/kms';

const supabaseAdmin = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

export async function POST(request: Request) {
  try {
    const authHeader = request.headers.get('Authorization');
    if (!authHeader) {
      return NextResponse.json({ error: 'Missing Authorization header' }, { status: 401 });
    }

    const token = authHeader.replace('Bearer ', '');
    const { data: { user }, error: userError } = await supabaseAdmin.auth.getUser(token);
    if (userError || !user) {
      return NextResponse.json({ error: 'Invalid token' }, { status: 401 });
    }

    const { email, phone } = await request.json();

    // Check if user already exists
    const { data: existingUser, error: checkError } = await supabaseAdmin
      .from('users')
      .select('id, wallet_address')
      .eq('id', user.id)
      .single();

    if (checkError && checkError.code !== 'PGRST116') {
      return NextResponse.json({ error: 'Database error' }, { status: 500 });
    }

    if (!existingUser) {
      // Derive wallet address via KMS (or mock in dev)
      let walletAddress: string;
      try {
        walletAddress = await deriveWalletAddress(user.id);
      } catch (kmsError) {
        console.error('KMS derivation failed, using fallback:', kmsError);
        walletAddress = `0xmock_${user.id.replace(/-/g, '').substring(0, 32)}`;
      }

      const { error: insertError } = await supabaseAdmin
        .from('users')
        .insert([{
          id: user.id,
          email: email || user.email,
          phone: phone || user.phone || null,
          wallet_address: walletAddress,
          tngn_balance: 0,
          bonus_balance: 0,
          free_bet_credits: 0,
          avatar_id: Math.floor(Math.random() * 50), // Random starter avatar
          profile_complete: false,
        }]);

      if (insertError) {
        console.error('Error creating user:', insertError);
        return NextResponse.json({ error: 'Failed to create user record' }, { status: 500 });
      }

      console.log(`New user: ${user.id} → ${walletAddress}`);
    }

    return NextResponse.json({ success: true });
  } catch (error: any) {
    console.error('Verify OTP Error:', error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}

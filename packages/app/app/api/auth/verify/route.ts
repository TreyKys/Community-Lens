import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { generateUserWallet } from '@/lib/kms';

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL || 'https://dummy-for-build.supabase.co';
const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || 'dummy_key';

export async function POST(req: NextRequest) {
  try {
    const { email, phone } = await req.json();

    if (!email && !phone) {
      return NextResponse.json({ error: 'Email or phone required' }, { status: 400 });
    }

    const supabase = createClient(supabaseUrl, supabaseServiceKey);
    const identifier = email || phone;
    const queryColumn = email ? 'email' : 'phone';

    // Check if user exists
    const { data: fetchUser, error: fetchError } = await supabase
      .from('users')
      .select('*')
      .eq(queryColumn, identifier)
      .single();

    if (fetchError && fetchError.code !== 'PGRST116') { // PGRST116 is "No rows found"
       return NextResponse.json({ error: 'Database error' }, { status: 500 });
    }
    let user = fetchUser;

    if (!user) {
        // Create new user flow with KMS Zero-Key Storage

        // 1. We need a unique ID for the KMS seed. Use Web Crypto API.
        const newUserId = globalThis.crypto.randomUUID();

        // 2. Generate EVM Wallet via KMS
        const { walletAddress } = await generateUserWallet(newUserId);

        // 3. Insert into DB with the generated wallet
        const { data: newUser, error: insertError } = await supabase
            .from('users')
            .insert({
                id: newUserId,
                [queryColumn]: identifier,
                wallet_address: walletAddress.toLowerCase(),
                is_custodial: true,
                tngn_balance: 0,
                free_bet_credits: 0
            })
            .select()
            .single();

        if (insertError) {
             console.error("Insert error:", insertError);
             return NextResponse.json({ error: 'Failed to create user' }, { status: 500 });
        }

        user = newUser;
    }

    // In a real production app, we would verify an OTP here using Supabase Auth.
    // For this pivot, we establish the user session by returning the user object.
    return NextResponse.json({ success: true, user }, { status: 200 });

  } catch (error: unknown) {
    console.error('Auth verify error:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

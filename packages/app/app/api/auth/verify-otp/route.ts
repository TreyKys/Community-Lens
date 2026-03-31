import { NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';

// Use the service role key so we can write to the users table bypassing RLS
const supabaseAdmin = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL || 'https://build-dummy.supabase.co',
  process.env.SUPABASE_SERVICE_ROLE_KEY || 'build-dummy-key'
);

export async function POST(request: Request) {
  try {
    const authHeader = request.headers.get('Authorization');
    if (!authHeader) {
      return NextResponse.json({ error: 'Missing Authorization header' }, { status: 401 });
    }

    const token = authHeader.replace('Bearer ', '');

    // Verify the session token with the admin client
    const { data: { user }, error: userError } = await supabaseAdmin.auth.getUser(token);
    if (userError || !user) {
      return NextResponse.json({ error: 'Invalid token' }, { status: 401 });
    }

    const { email, phone } = await request.json();

    // Check if this user already has a record
    const { data: existingUser, error: checkError } = await supabaseAdmin
      .from('users')
      .select('id')
      .eq('id', user.id)
      .single();

    if (checkError && checkError.code !== 'PGRST116') {
      console.error('DB error checking user:', checkError);
      return NextResponse.json({ error: 'Database error' }, { status: 500 });
    }

    if (!existingUser) {
      // -----------------------------------------------------------------
      // PHASE 3 TODO: Replace this mock address with a real AWS KMS call:
      //
      //   import { KMSClient, GenerateMacCommand } from "@aws-sdk/client-kms";
      //   const kms = new KMSClient({ region: process.env.AWS_REGION });
      //   const mac = await kms.send(new GenerateMacCommand({
      //     KeyId: process.env.AWS_KMS_KEY_ID,
      //     Message: Buffer.from(user.id),
      //     MacAlgorithm: "HMAC_SHA_256",
      //   }));
      //   const privateKey = mac.Mac; // derive EVM address from this
      //
      // For now we generate a deterministic mock address so the DB insert
      // works and the rest of the app is unblocked during testing.
      // -----------------------------------------------------------------
      const mockWalletAddress = `0xmock_${user.id.replace(/-/g, '').substring(0, 32)}`;

      const { error: insertError } = await supabaseAdmin
        .from('users')
        .insert([{
          id: user.id,
          email: email || user.email,
          phone: phone || user.phone || null,
          wallet_address: mockWalletAddress,
          tngn_balance: 0,
          bonus_balance: 0,
        }]);

      if (insertError) {
        console.error('Error creating user record:', insertError);
        return NextResponse.json({ error: 'Failed to create user record' }, { status: 500 });
      }

      console.log(`New user created: ${user.id} → ${mockWalletAddress}`);
    }

    return NextResponse.json({ success: true });
  } catch (error: any) {
    console.error('Verify OTP Error:', error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}

import { NextResponse } from 'next/server';
import { supabase } from '@/lib/supabase';

export async function POST(request: Request) {
  try {
    const authHeader = request.headers.get('Authorization');
    if (!authHeader) {
      return NextResponse.json({ error: 'Missing Authorization header' }, { status: 401 });
    }

    const token = authHeader.replace('Bearer ', '');
    const { data: { user }, error: userError } = await supabase.auth.getUser(token);

    if (userError || !user) {
      return NextResponse.json({ error: 'Invalid token' }, { status: 401 });
    }

    const { phone, email } = await request.json();

    // Check if user exists in the `users` table
    const { data: existingUser, error: checkError } = await supabase
      .from('users')
      .select('id')
      .eq('id', user.id)
      .single();

    if (checkError && checkError.code !== 'PGRST116') { // PGRST116 is "Row not found"
      console.error('Database error checking user:', checkError);
      return NextResponse.json({ error: 'Database error' }, { status: 500 });
    }

    if (!existingUser) {
      // Create user record.
      // walletAddress is required in current schema.
      // In phase 3, we will call AWS KMS here to derive a real address.
      // For now, we generate a mock placeholder address to unblock the database insert.
      const mockWalletAddress = `0xmock_${user.id.replace(/-/g, '').substring(0, 32)}`;

      const { error: insertError } = await supabase
        .from('users')
        .insert([{
          id: user.id,
          phone: phone || user.phone,
          email: email || user.email,
          walletAddress: mockWalletAddress,
          bonus_balance: 0,
        }]);

      if (insertError) {
        console.error('Error creating user record:', insertError);
        return NextResponse.json({ error: 'Failed to create user record' }, { status: 500 });
      }
    }

    return NextResponse.json({ success: true });
  } catch (error: any) {
    console.error('Verify OTP Error:', error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}

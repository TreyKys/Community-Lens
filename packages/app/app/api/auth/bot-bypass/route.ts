import { NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL || '';
const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || '';

export async function POST(request: Request) {
  try {
    // Check if bypass is enabled
    if (process.env.NEXT_PUBLIC_BYPASS_OTP !== 'true') {
      return NextResponse.json({ error: 'Forbidden: Bypass disabled' }, { status: 403 });
    }

    const { email } = await request.json();

    // Verify domain
    if (!email || !email.endsWith('@odds.ng')) {
      return NextResponse.json({ error: 'Forbidden: Invalid domain' }, { status: 403 });
    }

    const supabase = createClient(supabaseUrl, supabaseAnonKey);
    const masterPassword = process.env.BOT_MASTER_PASSWORD;

    if (!masterPassword) {
      return NextResponse.json({ error: 'Configuration Error: Master password not set in environment' }, { status: 500 });
    }

    // Authenticate with Supabase using the master password
    const { data, error } = await supabase.auth.signInWithPassword({
      email,
      password: masterPassword,
    });

    if (error) {
      return NextResponse.json({ error: error.message }, { status: 401 });
    }

    return NextResponse.json({ session: data.session, user: data.user }, { status: 200 });

  } catch (error: any) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}

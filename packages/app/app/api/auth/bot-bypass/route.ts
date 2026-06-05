import { NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';

const supabaseAdmin = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

export async function POST(request: Request) {
  if (process.env.NEXT_PUBLIC_BYPASS_OTP !== 'true') {
    return NextResponse.json({ error: 'Bypass disabled' }, { status: 403 });
  }

  try {
    const { email, password } = await request.json();

    if (password !== 'OddsNgBotSquad2026!') {
      return NextResponse.json({ error: 'Invalid master password' }, { status: 401 });
    }

    if (!email || !email.endsWith('@odds.ng')) {
       return NextResponse.json({ error: 'Bot bypass strictly limited to @odds.ng addresses.' }, { status: 403 });
    }

    const { data, error } = await supabaseAdmin.auth.signInWithPassword({
      email,
      password,
    });

    if (error) {
      return NextResponse.json({ error: error.message }, { status: 401 });
    }

    return NextResponse.json({ session: data.session });
  } catch (error: any) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}

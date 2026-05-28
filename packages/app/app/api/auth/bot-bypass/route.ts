import { NextResponse } from 'next/server';
import { supabase } from '@/lib/supabase';

export async function POST(req: Request) {
  try {
    const { email } = await req.json();
    const normalizedEmail = email?.trim().toLowerCase();

    if (!normalizedEmail || !normalizedEmail.includes('@odds.ng')) {
      return NextResponse.json({ error: 'Invalid bot email' }, { status: 400 });
    }

    if (process.env.NEXT_PUBLIC_BYPASS_OTP !== 'true') {
      return NextResponse.json({ error: 'Bypass not enabled' }, { status: 403 });
    }

    // Hardcoded master password per user instructions, but kept server-side to prevent exposing to client
    const password = 'OddsNgBotSquad2026!';

    const { data, error } = await supabase.auth.signInWithPassword({
      email: normalizedEmail,
      password: password,
    });

    if (error) {
      return NextResponse.json({ error: error.message }, { status: 400 });
    }

    return NextResponse.json({ session: data.session });
  } catch (error: any) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}

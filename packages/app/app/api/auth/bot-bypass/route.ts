import { NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';

const supabaseAdmin = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

export async function POST(req: Request) {
  try {
    const { email } = await req.json();
    const normalizedEmail = email?.trim().toLowerCase();

    if (!normalizedEmail || !normalizedEmail.includes('@odds.ng')) {
      return NextResponse.json({ error: 'Invalid bot email' }, { status: 400 });
    }

    if (String(process.env.NEXT_PUBLIC_BYPASS_OTP).toLowerCase() !== 'true') {
      return NextResponse.json({ error: 'Bypass not enabled' }, { status: 403 });
    }

    // Generate a magic link using the admin API
    const { data, error } = await supabaseAdmin.auth.admin.generateLink({
      type: 'magiclink',
      email: normalizedEmail,
    });

    if (error) {
      return NextResponse.json({ error: error.message }, { status: 400 });
    }

    return NextResponse.json({ action_link: data.properties.action_link });
  } catch (error: any) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}

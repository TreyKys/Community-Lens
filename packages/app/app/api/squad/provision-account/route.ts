import { NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { createVirtualAccount } from '@/lib/squad';

const supabaseAdmin = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

async function getAuthUser(request: Request) {
  const authHeader = request.headers.get('Authorization');
  if (!authHeader) return null;
  const token = authHeader.replace('Bearer ', '');
  const { data: { user }, error } = await supabaseAdmin.auth.getUser(token);
  if (error || !user) return null;
  return user;
}

/**
 * POST /api/squad/provision-account
 * Idempotently issue a Virtual NUBAN for the authenticated user.
 * Returns the cached account if one already exists.
 *
 * Accepts an optional { phone } in the body. If the user has no phone on
 * record, the supplied value is persisted to users.phone before being passed
 * to Squad. (No SMS verification — Termii will plug in later.)
 *
 * If the user has no phone and none is supplied, returns 400 with code "phone_required"
 * so the WalletModal can prompt for it inline.
 */
export async function POST(request: Request) {
  try {
    const authUser = await getAuthUser(request);
    if (!authUser) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

    const body = await request.json().catch(() => ({} as { phone?: string }));
    const submittedPhone = typeof body?.phone === 'string' ? body.phone.replace(/\D/g, '') : '';

    const { data: existing } = await supabaseAdmin
      .from('squad_virtual_accounts')
      .select('account_number, account_name, bank_name, bank_code')
      .eq('user_id', authUser.id)
      .single();

    if (existing) {
      return NextResponse.json({
        accountNumber: existing.account_number,
        accountName: existing.account_name,
        bankName: existing.bank_name,
        bankCode: existing.bank_code,
        cached: true,
      });
    }

    const { data: profile } = await supabaseAdmin
      .from('users')
      .select('email, username, phone')
      .eq('id', authUser.id)
      .single();

    const email = profile?.email || authUser.email || `${authUser.id}@odds.ng`;
    const fallbackName = profile?.username || email.split('@')[0] || 'Odds';
    const [firstName, ...rest] = fallbackName.split(/\s+/);
    const lastName = rest.join(' ') || 'User';

    // Squad requires a Nigerian mobile number. Pull it from the user record
    // first; fall back to anything the WalletModal just collected.
    const rawPhone = profile?.phone || authUser.phone || submittedPhone;
    const mobileNum = String(rawPhone || '').replace(/\D/g, '');

    if (!mobileNum) {
      return NextResponse.json(
        {
          error: 'Phone number required to issue a bank transfer account.',
          code: 'phone_required',
        },
        { status: 400 }
      );
    }

    // Sanity-check Nigerian mobile shape: 10 digits (without leading 0) or 11 (with), or 13 (intl 234…).
    if (mobileNum.length < 10 || mobileNum.length > 14) {
      return NextResponse.json(
        { error: 'Enter a valid Nigerian phone number (e.g. 08012345678).', code: 'phone_invalid' },
        { status: 400 }
      );
    }

    // Persist the phone to the user record on first capture so they don't have to retype it.
    if (!profile?.phone && submittedPhone) {
      await supabaseAdmin.from('users').update({ phone: mobileNum }).eq('id', authUser.id);
    }

    const account = await createVirtualAccount({
      customerIdentifier: authUser.id,
      firstName,
      lastName,
      email,
      mobileNum,
    });

    const { error: insertErr } = await supabaseAdmin.from('squad_virtual_accounts').insert({
      user_id: authUser.id,
      customer_identifier: account.customer_identifier || authUser.id,
      account_number: account.virtual_account_number,
      account_name: account.account_name,
      bank_code: account.bank_code || null,
      bank_name: account.bank || null,
      raw_response: account,
    });

    if (insertErr) {
      console.error('Failed to persist Squad virtual account:', insertErr);
      return NextResponse.json({ error: 'Database error' }, { status: 500 });
    }

    return NextResponse.json({
      accountNumber: account.virtual_account_number,
      accountName: account.account_name,
      bankName: account.bank,
      bankCode: account.bank_code,
      cached: false,
    });
  } catch (e: any) {
    console.error('Squad provision-account error:', e);
    return NextResponse.json({ error: e?.message || 'Internal error' }, { status: 500 });
  }
}

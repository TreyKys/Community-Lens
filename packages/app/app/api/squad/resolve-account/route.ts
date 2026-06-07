import { NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { resolveBankAccount } from '@/lib/squad';
import { findBankByCode } from '@/lib/banks';

const supabaseAdmin = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

/**
 * POST /api/squad/resolve-account
 * Body: { bankCode: string, accountNumber: string }
 *
 * Resolves a NUBAN to its account holder name via Squad's name-enquiry
 * endpoint, so the user can confirm "is this me?" before submitting a
 * withdrawal. Requires an authenticated session — this is not a public
 * lookup tool.
 */
export async function POST(request: Request) {
  try {
    const authHeader = request.headers.get('Authorization');
    if (!authHeader) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

    const token = authHeader.replace('Bearer ', '');
    const { data: { user }, error: authError } = await supabaseAdmin.auth.getUser(token);
    if (authError || !user) return NextResponse.json({ error: 'Invalid session' }, { status: 401 });

    const { bankCode, accountNumber } = await request.json();
    const code = String(bankCode || '').trim();
    const acct = String(accountNumber || '').trim();

    if (!code || acct.length !== 10) {
      return NextResponse.json({ error: 'Valid bank code + 10-digit account number required' }, { status: 400 });
    }
    if (!findBankByCode(code)) {
      return NextResponse.json({ error: 'Bank not in approved list' }, { status: 400 });
    }

    const resolved = await resolveBankAccount({ bankCode: code, accountNumber: acct });
    if (!resolved.accountName) {
      return NextResponse.json({ error: 'Could not resolve account name — check the details' }, { status: 422 });
    }

    return NextResponse.json({ accountName: resolved.accountName });
  } catch (error: any) {
    return NextResponse.json({ error: error.message || 'Account lookup failed' }, { status: 500 });
  }
}

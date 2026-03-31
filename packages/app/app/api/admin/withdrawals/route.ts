import { NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';

const supabaseAdmin = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL || 'https://build-dummy.supabase.co',
  process.env.SUPABASE_SERVICE_ROLE_KEY || 'build-dummy-key'
);

// GET: List all withdrawals pending admin approval
export async function GET(request: Request) {
  try {
    const authHeader = request.headers.get('Authorization');
    if (authHeader !== `Bearer ${process.env.ADMIN_SECRET}`) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const { data, error } = await supabaseAdmin
      .from('withdrawals')
      .select('*, users(email, tngn_balance)')
      .eq('requires_admin_approval', true)
      .eq('status', 'pending_admin_approval')
      .order('created_at', { ascending: false });

    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    return NextResponse.json({ withdrawals: data });

  } catch (error: any) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}

// POST: Approve or reject a large withdrawal
export async function POST(request: Request) {
  try {
    const authHeader = request.headers.get('Authorization');
    if (authHeader !== `Bearer ${process.env.ADMIN_SECRET}`) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const { withdrawalId, action, reason } = await request.json();
    // action: 'approve' | 'reject'

    if (!withdrawalId || !action) {
      return NextResponse.json({ error: 'Missing fields' }, { status: 400 });
    }

    const { data: withdrawal, error: wdError } = await supabaseAdmin
      .from('withdrawals')
      .select('*')
      .eq('id', withdrawalId)
      .single();

    if (wdError || !withdrawal) {
      return NextResponse.json({ error: 'Withdrawal not found' }, { status: 404 });
    }

    if (action === 'reject') {
      // Refund the user's balance
      const { data: userData } = await supabaseAdmin
        .from('users')
        .select('tngn_balance')
        .eq('id', withdrawal.user_id)
        .single();

      if (userData) {
        await supabaseAdmin
          .from('users')
          .update({ tngn_balance: (userData.tngn_balance || 0) + withdrawal.amount_tngn })
          .eq('id', withdrawal.user_id);
      }

      await supabaseAdmin
        .from('withdrawals')
        .update({ status: 'rejected', admin_note: reason || 'Rejected by admin', processed_at: new Date().toISOString() })
        .eq('id', withdrawalId);

      return NextResponse.json({ success: true, status: 'rejected' });
    }

    if (action === 'approve') {
      // TODO: Trigger Paystack transfer here (same as standard withdrawal)
      await supabaseAdmin
        .from('withdrawals')
        .update({ status: 'approved_queued_for_paystack', processed_at: new Date().toISOString() })
        .eq('id', withdrawalId);

      return NextResponse.json({ success: true, status: 'approved' });
    }

    return NextResponse.json({ error: 'Invalid action' }, { status: 400 });

  } catch (error: any) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}

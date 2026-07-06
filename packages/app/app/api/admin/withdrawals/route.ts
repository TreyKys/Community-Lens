import { NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { isAdminRequest } from '@/lib/adminAuth';

const supabaseAdmin = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

// GET: List all withdrawals pending admin approval
export async function GET(request: Request) {
  try {
    if (!isAdminRequest(request)) {
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
    if (!isAdminRequest(request)) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const { withdrawalId, action, reason } = await request.json();
    // action: 'approve' | 'reject'

    if (!withdrawalId || !action) {
      return NextResponse.json({ error: 'Missing fields' }, { status: 400 });
    }

    if (action === 'reject') {
      // Atomic CAS: only one admin can flip status from 'pending_admin_approval'
      // to 'rejected'. Loser bails — prevents double-refund when two admins
      // click reject simultaneously.
      const { data: rejected } = await supabaseAdmin
        .from('withdrawals')
        .update({
          status: 'rejected',
          admin_note: reason || 'Rejected by admin',
          processed_at: new Date().toISOString(),
        })
        .eq('id', withdrawalId)
        .eq('status', 'pending_admin_approval')
        .select('user_id, amount_tngn')
        .maybeSingle();

      if (!rejected) {
        return NextResponse.json(
          { error: 'Withdrawal not found or already processed' },
          { status: 409 },
        );
      }

      const { error: refundErr } = await supabaseAdmin.rpc('credit_user', {
        p_user_id: rejected.user_id,
        p_tngn_delta: Number(rejected.amount_tngn),
        p_bonus_delta: 0,
      });
      if (refundErr) {
        console.error('Refund failed after reject — manual recovery needed:', { withdrawalId, refundErr });
        return NextResponse.json({ error: 'Refund failed' }, { status: 500 });
      }

      return NextResponse.json({ success: true, status: 'rejected' });
    }

    if (action === 'approve') {
      // Atomic CAS — only one admin can transition to approved_queued_for_paystack.
      const { data: approved } = await supabaseAdmin
        .from('withdrawals')
        .update({
          status: 'approved_queued_for_paystack',
          processed_at: new Date().toISOString(),
        })
        .eq('id', withdrawalId)
        .eq('status', 'pending_admin_approval')
        .select('id')
        .maybeSingle();

      if (!approved) {
        return NextResponse.json(
          { error: 'Withdrawal not found or already processed' },
          { status: 409 },
        );
      }

      return NextResponse.json({ success: true, status: 'approved' });
    }

    return NextResponse.json({ error: 'Invalid action' }, { status: 400 });

  } catch (error: any) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}

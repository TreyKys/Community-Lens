import { NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { isAdminRequest } from '@/lib/adminAuth';

export const maxDuration = 60;
export const dynamic = 'force-dynamic';
export const revalidate = 0;

const supabaseAdmin = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
);

// GET /api/admin/user-trace?userId=… OR ?email=… OR ?complaintId=…
//
// Pulls a user's full recent story in one shot — every bet, slip, deposit,
// withdrawal, treasury_log entry, notification, and complaint they touched.
// Designed to be the "one screen" an admin opens when investigating a
// complaint: no clicking through six different tabs to reconstruct what
// happened.
export async function GET(request: Request) {
  if (!isAdminRequest(request)) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const url = new URL(request.url);
  let userId = url.searchParams.get('userId');
  const email = url.searchParams.get('email');
  const complaintId = url.searchParams.get('complaintId');

  // Resolve user by whichever selector was passed.
  if (!userId && email) {
    const { data: u } = await supabaseAdmin.from('users').select('id').eq('email', email.toLowerCase()).maybeSingle();
    userId = u?.id ?? null;
  }
  if (!userId && complaintId) {
    const { data: c } = await supabaseAdmin.from('user_complaints').select('user_id').eq('id', complaintId).maybeSingle();
    userId = c?.user_id ?? null;
  }
  if (!userId) return NextResponse.json({ error: 'Provide userId, email, or complaintId' }, { status: 400 });

  const sinceHours = Number(url.searchParams.get('sinceHours')) || 168;      // default 7 days
  const since = new Date(Date.now() - sinceHours * 60 * 60 * 1000).toISOString();

  const [
    user,
    bets,
    slips,
    deposits,
    withdrawals,
    treasury,
    notifications,
    complaints,
  ] = await Promise.all([
    supabaseAdmin.from('users').select('id, email, username, tngn_balance, bonus_balance, bonus_expires_at, created_at').eq('id', userId).maybeSingle(),
    supabaseAdmin.from('user_bets').select('id, market_id, outcome_index, stake_tngn, net_stake_tngn, payout_tngn, status, bonus_proportion, placed_at, markets:market_id (id, question, status, resolved_outcome)').eq('user_id', userId).gte('placed_at', since).order('placed_at', { ascending: false }).limit(100),
    supabaseAdmin.from('multiplier_slips').select('id, slip_stake_tngn, final_payout_tngn, legs_total, legs_resolved, legs_won, status, created_at, settled_at, bonus_proportion').eq('user_id', userId).gte('created_at', since).order('created_at', { ascending: false }).limit(50),
    supabaseAdmin.from('squad_transactions').select('id, amount, reference, status, created_at').eq('user_id', userId).gte('created_at', since).order('created_at', { ascending: false }).limit(30).then(r => r, () => ({ data: null, error: null } as any)),
    supabaseAdmin.from('withdrawals').select('id, amount, status, created_at, updated_at').eq('user_id', userId).gte('created_at', since).order('created_at', { ascending: false }).limit(30).then(r => r, () => ({ data: null, error: null } as any)),
    supabaseAdmin.from('treasury_log').select('id, type, amount_tngn, market_id, bet_id, metadata, created_at').eq('user_id', userId).gte('created_at', since).order('created_at', { ascending: false }).limit(100),
    supabaseAdmin.from('notifications').select('id, type, severity, category, message, reference_code, is_read, created_at').eq('user_id', userId).gte('created_at', since).order('created_at', { ascending: false }).limit(50),
    supabaseAdmin.from('user_complaints').select('id, reference_code, type, status, ai_triage_category, description, admin_response, created_at, resolved_at').eq('user_id', userId).order('created_at', { ascending: false }).limit(20),
  ]);

  return NextResponse.json({
    user: user.data,
    windowHours: sinceHours,
    bets: bets.data || [],
    slips: slips.data || [],
    deposits: (deposits as any).data || [],
    withdrawals: (withdrawals as any).data || [],
    treasury: treasury.data || [],
    notifications: notifications.data || [],
    complaints: complaints.data || [],
  }, { headers: { 'Cache-Control': 'no-store' } });
}

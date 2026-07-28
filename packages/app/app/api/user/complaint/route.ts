import { NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { triageComplaint } from '@/lib/mechanic/triage';
import { attemptComplaintAutoFix } from '@/lib/mechanic/complaintAutoFix';
import { getAuthUser } from '@/lib/getAuthUser';

export const maxDuration = 60;
export const dynamic = 'force-dynamic';
export const revalidate = 0;

const supabaseAdmin = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
);

const VALID_TYPES = ['bet_stuck', 'deposit_missing', 'withdrawal_delayed', 'balance_wrong', 'other'];
const MAX_PER_USER_PER_HOUR = 5;


// POST /api/user/complaint
//
// User-side complaint submission. Body:
//   {
//     type:              'bet_stuck' | 'deposit_missing' | 'withdrawal_delayed' | 'balance_wrong' | 'other',
//     description?:      string (free text),
//     relatedBetId?:     string,
//     relatedSlipId?:    string,
//     relatedMarketId?:  number,
//     context?:          arbitrary jsonb (page, user_agent, recent actions)
//   }
//
// Returns a reference code + friendly status message. Rate-limited to
// MAX_PER_USER_PER_HOUR to prevent abuse. Auto-fix is attempted per
// triaged category — if it succeeds, the user is told "we found and
// fixed it, please refresh." If not, they get "we're looking into it."
export async function POST(request: Request) {
  try {
    const user = await getAuthUser(supabaseAdmin, request);
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

    let body: any;
    try { body = await request.json(); }
    catch { return NextResponse.json({ error: 'Malformed body' }, { status: 400 }); }

    const type = String(body?.type || '').trim();
    if (!VALID_TYPES.includes(type)) {
      return NextResponse.json({ error: `type must be one of ${VALID_TYPES.join(', ')}` }, { status: 400 });
    }
    const description = typeof body?.description === 'string' ? body.description.slice(0, 4000) : null;
    const relatedBetId    = typeof body?.relatedBetId === 'string' ? body.relatedBetId : null;
    const relatedSlipId   = typeof body?.relatedSlipId === 'string' ? body.relatedSlipId : null;
    const relatedMarketId = Number.isInteger(Number(body?.relatedMarketId)) ? Number(body.relatedMarketId) : null;
    const context = body?.context && typeof body.context === 'object' ? body.context : {};

    // Rate limit: N complaints per user per hour.
    const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    const { count: recentCount } = await supabaseAdmin
      .from('user_complaints')
      .select('id', { count: 'exact', head: true })
      .eq('user_id', user.id)
      .gte('created_at', oneHourAgo);
    if ((recentCount ?? 0) >= MAX_PER_USER_PER_HOUR) {
      return NextResponse.json({
        error: `Rate limit: max ${MAX_PER_USER_PER_HOUR} complaints per hour. If your existing complaints haven&apos;t been resolved, we&apos;ll get back to you shortly.`,
      }, { status: 429 });
    }

    // Auto-attach a snapshot of the user's current state.
    const { data: userRow } = await supabaseAdmin
      .from('users')
      .select('email, username, tngn_balance, bonus_balance, bonus_expires_at')
      .eq('id', user.id)
      .maybeSingle();
    const enrichedContext = {
      ...context,
      user_email: userRow?.email,
      username: userRow?.username,
      snapshot: {
        tngn_balance: Number(userRow?.tngn_balance || 0),
        bonus_balance: Number(userRow?.bonus_balance || 0),
        bonus_expires_at: userRow?.bonus_expires_at,
      },
      submitted_at: new Date().toISOString(),
    };

    // Generate the human reference code first — done inside the DB via
    // the migration's generate_complaint_reference_code() helper so it
    // stays collision-safe across concurrent submissions.
    const { data: refRow, error: refErr } = await supabaseAdmin
      .rpc('generate_complaint_reference_code');
    if (refErr) {
      console.error('generate_complaint_reference_code failed:', refErr);
      return NextResponse.json({ error: 'Internal error generating reference code' }, { status: 500 });
    }
    const referenceCode = refRow as unknown as string;

    // AI triage runs in parallel with the row insert prep.
    const [triage] = await Promise.all([
      triageComplaint({
        userDeclaredType: type,
        description,
        context: enrichedContext,
      }),
    ]);

    // Insert the complaint at status='submitted', then attempt auto-fix.
    const { data: inserted, error: insertErr } = await supabaseAdmin
      .from('user_complaints')
      .insert({
        user_id: user.id,
        reference_code: referenceCode,
        type,
        description,
        related_bet_id: relatedBetId,
        related_slip_id: relatedSlipId,
        related_market_id: relatedMarketId,
        context: enrichedContext,
        status: 'submitted',
        ai_triage_category: triage.category,
        ai_triage_confidence: triage.confidence,
      })
      .select('id, reference_code, status, created_at')
      .single();
    if (insertErr) {
      console.error('user_complaints insert failed:', insertErr);
      return NextResponse.json({ error: 'Failed to record complaint — please try again.' }, { status: 500 });
    }

    // Duplicate aggregation: if there's already an OPEN complaint with
    // the same triage category from a different user in the last 24h
    // AND it points at the same market/slip/bet, tag this one as a
    // child of that group. (Same user filing again just gets counted
    // by rate-limit — no aggregation.)
    let aggregateParentId: string | null = null;
    try {
      const dayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
      const dupeMatches: string[] = [];
      let dupeQuery = supabaseAdmin
        .from('user_complaints')
        .select('id')
        .eq('ai_triage_category', triage.category)
        .neq('user_id', user.id)
        .in('status', ['submitted', 'monitor_review', 'admin_working'])
        .is('aggregate_parent_id', null)
        .gte('created_at', dayAgo)
        .limit(1);
      if (relatedSlipId) dupeQuery = dupeQuery.eq('related_slip_id', relatedSlipId);
      else if (relatedBetId) dupeQuery = dupeQuery.eq('related_bet_id', relatedBetId);
      else if (relatedMarketId) dupeQuery = dupeQuery.eq('related_market_id', relatedMarketId);
      else dupeMatches.push(''); // no linkable id → skip aggregation
      if (dupeMatches.length === 0) {
        const { data: parent } = await dupeQuery.maybeSingle();
        if (parent?.id) {
          aggregateParentId = parent.id;
          await supabaseAdmin
            .from('user_complaints')
            .update({ aggregate_parent_id: parent.id })
            .eq('id', inserted.id);
        }
      }
    } catch (e) {
      console.error('aggregation check failed (non-fatal):', e);
    }

    // Attempt auto-fix in the background of the response — but await
    // so we can tell the user something concrete.
    let autoFix;
    try {
      await supabaseAdmin.from('user_complaints').update({
        status: 'mechanic_attempting',
        mechanic_attempted: true,
      }).eq('id', inserted.id);

      autoFix = await attemptComplaintAutoFix(supabaseAdmin, {
        userId: user.id,
        triageCategory: triage.category,
        relatedBetId,
        relatedSlipId,
      });

      // Per the design: never tell the user "we fixed it" from this
      // endpoint. Monitor's verify step (checkpoint 7) is what
      // authorises that message once it confirms the underlying
      // issue is actually gone. For now Mechanic just records what
      // it did.
      const nextStatus = autoFix.applied ? 'mechanic_fixed' : 'monitor_review';
      await supabaseAdmin.from('user_complaints').update({
        status: nextStatus,
        mechanic_result: autoFix as any,
      }).eq('id', inserted.id);
    } catch (e: any) {
      console.error('complaint auto-fix crashed:', e);
      await supabaseAdmin.from('user_complaints').update({
        status: 'monitor_review',
        mechanic_result: { error: e?.message || String(e) },
      }).eq('id', inserted.id);
    }

    // Notify the user — friendly, non-committal per your design call.
    try {
      await supabaseAdmin.from('notifications').insert({
        user_id: user.id,
        type: 'complaint_received',
        severity: 'info',
        category: 'complaint',
        reference_code: referenceCode,
        message: `We&#39;re looking into your report (ref ${referenceCode}). We&#39;ll update you here as soon as it&#39;s addressed.`,
      });
    } catch { /* non-critical */ }

    // If aggregation collapsed onto an existing group, don't spawn a
    // new system_alert — just update the parent's occurrence count.
    if (aggregateParentId) {
      // No-op here; /ops shows the parent group with a "N users
      // reporting" badge derived from aggregate_parent_id.
    }

    return NextResponse.json({
      ok: true,
      referenceCode,
      status: 'submitted',
      message: 'We&#39;re looking into it and will get back to you shortly.',
      // Deliberately do NOT tell the user "we fixed it" here even if
      // mechanic_fixed — see the design note above.
      triageCategory: triage.category,
    });
  } catch (e: any) {
    console.error('/api/user/complaint crashed:', e);
    return NextResponse.json({ error: 'Internal error — please try again.' }, { status: 500 });
  }
}

// GET /api/user/complaint — user's own complaint history
export async function GET(request: Request) {
  const user = await getAuthUser(supabaseAdmin, request);
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const { data, error } = await supabaseAdmin
    .from('user_complaints')
    .select('id, reference_code, type, status, ai_triage_category, admin_response, admin_responded_at, created_at, resolved_at')
    .eq('user_id', user.id)
    .order('created_at', { ascending: false })
    .limit(50);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ complaints: data || [] }, {
    headers: { 'Cache-Control': 'no-store, no-cache, must-revalidate, max-age=0' },
  });
}

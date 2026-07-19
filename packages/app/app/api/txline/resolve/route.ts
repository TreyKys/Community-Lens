import { NextResponse } from 'next/server';
import { getSupabaseAdmin, getBaseUrl } from '@/lib/oracle';
import { isAdminRequest } from '@/lib/adminAuth';

export const dynamic = 'force-dynamic';
export const maxDuration = 120;

type Source = 'feed' | 'admin_override';

/**
 * Resolve a TxLINE-mapped market with recorded provenance.
 *
 * Governance rule: the signed feed is the default source of truth; any
 * departure is recorded, attributed, and shown publicly. So:
 *   - source='feed'          -> accept the proof's proposedOutcome as-is
 *   - source='admin_override' -> a human chose a different outcome; an
 *                                override_reason is REQUIRED and stored.
 *
 * Provenance is written to the market first, then the existing, battle-tested
 * /api/markets/resolve runs the actual payout. The resolver only updates
 * status/resolved_outcome/resolved_at, so the provenance columns survive.
 */
export async function POST(request: Request) {
  if (!isAdminRequest(request)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const body = await request.json().catch(() => ({}));
  const marketId = body?.marketId;
  const source: Source = body?.source === 'admin_override' ? 'admin_override' : 'feed';
  const overrideReason: string | undefined = body?.overrideReason?.toString().trim() || undefined;

  if (!marketId) {
    return NextResponse.json({ error: 'Missing marketId' }, { status: 400 });
  }

  const supabaseAdmin = getSupabaseAdmin();
  const { data: market, error } = await supabaseAdmin
    .from('markets')
    .select('id, status, options, txline_fixture_id, txline_proof')
    .eq('id', marketId)
    .single();
  if (error || !market) return NextResponse.json({ error: 'Market not found' }, { status: 404 });
  if (!market.txline_fixture_id) {
    return NextResponse.json({ error: 'Not a TxLINE-mapped market' }, { status: 400 });
  }

  const proof: any = market.txline_proof;
  // Default the winning index from the proof for a straight feed acceptance.
  let winningOutcomeIndex: number | undefined =
    body?.winningOutcomeIndex !== undefined && body?.winningOutcomeIndex !== null
      ? Number(body.winningOutcomeIndex)
      : source === 'feed'
        ? proof?.proposedOutcome
        : undefined;

  if (winningOutcomeIndex === undefined || !Number.isInteger(winningOutcomeIndex)) {
    return NextResponse.json({ error: 'Missing winningOutcomeIndex' }, { status: 400 });
  }
  const optionsLen = Array.isArray(market.options) ? market.options.length : 0;
  if (winningOutcomeIndex < 0 || winningOutcomeIndex >= optionsLen) {
    return NextResponse.json({ error: 'winningOutcomeIndex out of range' }, { status: 400 });
  }

  if (source === 'admin_override') {
    if (!overrideReason) {
      return NextResponse.json({ error: 'override_reason is required for an override' }, { status: 400 });
    }
    // An override that lands on the same outcome the feed proposed isn't really
    // an override — guard against a mislabeled call muddying the audit trail.
    if (proof?.proposedOutcome === winningOutcomeIndex) {
      return NextResponse.json(
        { error: 'Chosen outcome equals the feed proposal — use source=feed instead of override.' },
        { status: 400 }
      );
    }
  }

  // The resolver requires a locked market. Lock it if still open.
  if (market.status === 'open') {
    await supabaseAdmin.from('markets').update({ status: 'locked' }).eq('id', marketId);
  }

  // Write provenance BEFORE the resolver runs.
  await supabaseAdmin
    .from('markets')
    .update({
      resolution_source: source,
      override_reason: source === 'admin_override' ? overrideReason : null,
      resolved_by: 'admin',
    })
    .eq('id', marketId);

  // Delegate the actual payout to the existing resolver via the cron secret
  // (a server-side self-call has no admin cookie, but the resolver also
  // accepts x-cron-secret).
  const res = await fetch(`${getBaseUrl()}/api/markets/resolve`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-cron-secret': process.env.CRON_SECRET || '' },
    body: JSON.stringify({ marketId, winningOutcomeIndex }),
  });
  const resolveBody = await res.json().catch(() => ({}));

  if (!res.ok) {
    return NextResponse.json(
      { ok: false, stage: 'resolve', status: res.status, error: resolveBody?.error || 'resolve failed' },
      { status: res.status }
    );
  }

  return NextResponse.json({
    ok: true,
    marketId,
    resolution_source: source,
    winningOutcomeIndex,
    override_reason: source === 'admin_override' ? overrideReason : null,
    resolve: resolveBody,
  });
}

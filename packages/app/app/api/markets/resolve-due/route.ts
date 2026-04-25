import { NextResponse } from 'next/server';
import { getSupabaseAdmin, getBaseUrl, cronHeaders, lookupMarketResult } from '@/lib/oracle';

export const dynamic = 'force-dynamic';

export async function POST(request: Request) {
  const cronSecret = request.headers.get('x-cron-secret');
  if (cronSecret !== process.env.CRON_SECRET) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const supabaseAdmin = getSupabaseAdmin();
  const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();

  const { data: markets } = await supabaseAdmin
    .from('markets')
    .select('id, title, fixture_id, sport, options, resolution_attempts, closes_at')
    .eq('status', 'locked')
    .eq('category', 'sports')
    .not('fixture_id', 'is', null)
    .lt('closes_at', twoHoursAgo)
    .limit(50);

  if (!markets?.length) {
    return NextResponse.json({ checked: 0, resolved: 0 });
  }

  const results: any[] = [];
  const baseUrl = getBaseUrl();

  for (const m of markets) {
    const attempts = (m as any).resolution_attempts || 0;
    if (attempts > 576) {
      try {
        await supabaseAdmin.from('notifications').insert({
          user_id: null,
          type: 'admin_alert',
          message: `⚠️ Market ${m.id} (${m.title}) unresolved after 48h. Manual resolution required.`,
        });
      } catch {}
      results.push({ marketId: m.id, success: false, reason: 'max_attempts' });
      continue;
    }

    await supabaseAdmin
      .from('markets')
      .update({ resolution_attempts: attempts + 1 })
      .eq('id', m.id);

    const { winningOutcomeIndex, reason } = await lookupMarketResult({
      id: m.id,
      sport: (m as any).sport,
      fixture_id: (m as any).fixture_id,
      options: (m.options as string[]) || [],
    });

    if (winningOutcomeIndex === null) {
      results.push({ marketId: m.id, success: false, reason });
      continue;
    }

    const resolveRes = await fetch(`${baseUrl}/api/markets/resolve`, {
      method: 'POST',
      headers: cronHeaders(),
      body: JSON.stringify({ marketId: m.id, winningOutcomeIndex }),
    });
    const body = await resolveRes.json().catch(() => ({}));

    if (!resolveRes.ok) {
      results.push({ marketId: m.id, success: false, error: body.error });
    } else {
      results.push({ marketId: m.id, success: true, outcome: winningOutcomeIndex });
    }
  }

  return NextResponse.json({
    checked: markets.length,
    resolved: results.filter((r) => r.success).length,
    results,
  });
}

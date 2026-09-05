import { NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { generateMarketContext, type ContextItem } from '@/lib/openMarketContext';

export const dynamic = 'force-dynamic';

const supabaseAdmin = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
);

// Regenerate every 14 days. This is general background on the market's
// SUBJECT ("what moves fuel prices"), not live odds — it does not go stale
// in an afternoon, and Gemini calls cost real money, so the point of caching
// this in the database at all is to make that cost roughly one call per
// market per fortnight rather than one call per page view.
const FRESH_MS = 14 * 24 * 60 * 60 * 1000;

// GET /api/open-markets/[id]/context — "More about this market".
//
// Public, unauthenticated: this is the same neutral background any visitor
// sees, not anything tied to who is asking. Fetched by the client as its own
// call, separate from the main market GET, so a slow or failed Gemini call
// never blocks or breaks the trading page itself — on any failure this
// route degrades to stale cached content if there is any, or an empty list.
export async function GET(_request: Request, { params }: { params: { id: string } }) {
  const { data: m, error } = await supabaseAdmin
    .from('open_markets')
    .select('id, question, description, category, resolution_source, status, ai_context, ai_context_generated_at')
    .eq('id', params.id)
    .maybeSingle();

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  if (!m) return NextResponse.json({ error: 'Market not found' }, { status: 404 });
  if (['pending_review', 'revise', 'rejected'].includes(m.status)) {
    return NextResponse.json({ error: 'Market not found' }, { status: 404 });
  }

  const cached = (m.ai_context as ContextItem[] | null) || null;
  const generatedAt = m.ai_context_generated_at ? new Date(m.ai_context_generated_at).getTime() : 0;
  const fresh = cached && cached.length > 0 && Date.now() - generatedAt < FRESH_MS;

  if (fresh) {
    return NextResponse.json({ items: cached, generatedAt: m.ai_context_generated_at });
  }

  try {
    const items = await generateMarketContext({
      question: m.question,
      description: m.description,
      category: m.category,
      resolutionSource: m.resolution_source,
    });

    const generatedAtIso = new Date().toISOString();
    // Best-effort. A failed write here just means the next viewer pays the
    // same Gemini call again — worse for cost, not for correctness, so it is
    // not worth failing the request over.
    await supabaseAdmin
      .from('open_markets')
      .update({ ai_context: items, ai_context_generated_at: generatedAtIso })
      .eq('id', params.id);

    return NextResponse.json({ items, generatedAt: generatedAtIso });
  } catch (e: any) {
    console.error('open market context generation failed', params.id, e?.message || e);
    // Stale beats nothing: an old-but-still-true background note is better
    // than an empty panel because Gemini timed out this one time.
    if (cached && cached.length > 0) {
      return NextResponse.json({ items: cached, generatedAt: m.ai_context_generated_at, stale: true });
    }
    return NextResponse.json({ items: [] });
  }
}

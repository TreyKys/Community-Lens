import { NextResponse } from 'next/server';
import { isAdminRequest } from '@/lib/adminAuth';
import { getSupabaseAdmin } from '@/lib/oracle';
import { budgetSummary } from '@/lib/social/budget';

// GET /api/social/status
//
// One call that answers "is the social system healthy and what has it
// cost me". Admin-only — spend figures and the pending queue are not
// public.

export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  if (!isAdminRequest(request)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const supa = getSupabaseAdmin();
  const since = new Date(Date.now() - 7 * 24 * 3600 * 1000).toISOString();

  const [budget, posts, replies, recent] = await Promise.all([
    budgetSummary().catch((e) => ({ error: String(e?.message ?? e) })),
    supa.from('social_posts').select('status').gte('created_at', since),
    supa.from('social_replies').select('status').gte('created_at', since),
    supa
      .from('social_posts')
      .select('id, kind, body, status, scheduled_at, published_at, provider_post_id, last_error')
      .order('created_at', { ascending: false })
      .limit(15),
  ]);

  const tally = (rows: any[] | null) =>
    (rows ?? []).reduce<Record<string, number>>((acc, r) => {
      acc[r.status] = (acc[r.status] ?? 0) + 1;
      return acc;
    }, {});

  return NextResponse.json({
    budget,
    last7Days: {
      posts: tally(posts.data),
      replies: tally(replies.data),
    },
    recentPosts: recent.data ?? [],
  });
}

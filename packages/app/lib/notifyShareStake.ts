import type { SupabaseClient } from '@supabase/supabase-js';

// When the recipient of a shared OPx Pick stakes it — "stake as is" or
// after editing ("make it yours") — notify the ORIGINAL sharer with a
// bit of engagement.
//
// Correctness rules baked in here, not left to callers:
//   * The sharer's identity is ALWAYS resolved from the DB by the share
//     id — never trusted from the client, which could otherwise claim
//     any user is the sharer.
//   * A user staking their OWN shared pick is never notified (self-stake
//     skip), so re-staking or previewing your own share stays silent.
//   * Fire-and-forget: any failure here must never affect the bet/slip
//     that was just placed — the whole thing is wrapped and swallowed.
//
// The copy deliberately does NOT claim the sharer is "earning" money —
// there is no sharer reward mechanism today, so it celebrates the reach
// honestly instead. Swap to an earning message only once a real reward
// is wired up.
export async function notifyShareStake(
  db: SupabaseClient,
  opts: { fromShareId: string | null | undefined; stakerUserId: string },
): Promise<void> {
  try {
    const shareId = String(opts.fromShareId || '').trim();
    if (!shareId) return;

    // The share id is a bet id or a slip id. Resolve the owner from
    // whichever table it belongs to (UUID PKs don't collide across the
    // two). This is the authoritative "who shared it" — server-side only.
    let ownerId: string | null = null;
    let kind: 'bet' | 'slip' = 'bet';

    const { data: bet } = await db
      .from('user_bets')
      .select('user_id')
      .eq('id', shareId)
      .maybeSingle();
    if (bet?.user_id) {
      ownerId = bet.user_id as string;
      kind = 'bet';
    } else {
      const { data: slip } = await db
        .from('multiplier_slips')
        .select('user_id')
        .eq('id', shareId)
        .maybeSingle();
      if (slip?.user_id) {
        ownerId = slip.user_id as string;
        kind = 'slip';
      }
    }

    if (!ownerId) return;                      // unknown/invalid share id
    if (ownerId === opts.stakerUserId) return; // never notify yourself

    const message = kind === 'slip'
      ? 'Someone just backed a Multiplier you shared — your calls are spreading. Keep sharing!'
      : 'Someone just staked a pick you shared — your calls are spreading. Keep sharing!';

    await db.from('notifications').insert({
      user_id: ownerId,
      type: 'share_staked',
      message,
    });
  } catch {
    // Non-critical — a notification failure must never touch the placement.
  }
}

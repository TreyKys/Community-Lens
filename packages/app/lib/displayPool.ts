// SINGLE source of truth for what users see when they look at a market pool.
// The actual total_pool stored in DB is the gross net-stake total. We surface
// it to users net of the platform's 10% pool rake — this matches the resolution
// math (see lib/payout.ts), so what users see is exactly what they will share
// if they win.
//
// IMPORTANT: never render `market.total_pool` directly in user-facing UI.
// Always run it through this function. The 10% rake is treasury revenue and
// is never shown anywhere user-visible.

export const POOL_RAKE_PCT = 0.10;

export function getDisplayPool(actualPool: number | null | undefined): number {
  const n = Number(actualPool || 0);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.round(n * (1 - POOL_RAKE_PCT));
}

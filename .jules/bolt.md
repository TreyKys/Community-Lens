## 2025-01-01 - MarketCard Unnecessary Re-renders
**Learning:** Component `MarketList` maps over `markets` to render `MarketCard`s but doesn't wrap `MarketCard` in `React.memo`, causing all market cards to re-render when list state changes (like when fetching markets or updating active bets).
**Action:** Wrap `MarketCard` in `React.memo` to optimize frontend performance in lists.

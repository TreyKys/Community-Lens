## 2024-07-18 - [Memoizing MarketCard in MarketList]
**Learning:** React mapping over arrays returning new objects from Supabase causes unnecessary re-renders of list components like `MarketCard`.
**Action:** Use `React.memo` for mapped list items (like `MarketCard` inside `MarketList`) and use `useCallback` for functions passed as props to avoid these re-renders. Check `memory` block for explicit instruction regarding this.

## 2024-07-19 - React Memoization for Supabase Queries
**Learning:** Supabase queries dynamically reconstruct object instances, returning entirely new memory references. Mapped lists relying on these queries will over-render unless wrapped with `React.memo` and stabilized with `useCallback`.
**Action:** Always wrap mapped React components powered by Supabase lists in `React.memo` and ensure callbacks are stabilized with `useCallback` to prevent unnecessary component re-renders. Avoid custom `propsAreEqual` functions to prevent stale UI bugs.

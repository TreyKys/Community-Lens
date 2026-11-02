## 2025-02-09 - React.memo deep equality anti-pattern
**Learning:** Using `JSON.stringify` in a custom equality function for `React.memo` (to deeply compare objects like `market`) is an O(N) anti-pattern that creates a severe performance bottleneck during the React render cycle.
**Action:** Instead of `JSON.stringify`, manually compare only the specific primitive properties of the object that determine whether the component should update (e.g., `id`, `total_pool`, `status`).

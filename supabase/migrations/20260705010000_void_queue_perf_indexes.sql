-- The pending-void queue (GET /api/admin/void-queue) was doing 1 + 6*N
-- round trips to render N pending markets. The application-side fix
-- batches those into 6 total IN-queries; these indexes make the
-- underlying lookups cheap regardless of table size.

-- Queue listing: WHERE status = 'pending_void' ORDER BY void_requested_at.
CREATE INDEX IF NOT EXISTS markets_pending_void_idx
  ON public.markets (void_requested_at)
  WHERE status = 'pending_void';

-- Duplicate-question corroboration check: WHERE question IN (...).
CREATE INDEX IF NOT EXISTS markets_question_idx
  ON public.markets (question);

-- Void requests now require admin approval instead of applying instantly.
--
-- The resolve route used to void a market immediately whenever it looked
-- like there were no bets on it (empty user_bets query). That's dangerous
-- for exactly the failure mode that prompted this: if bets exist in
-- reality but a placement bug means the row never landed, the market
-- looks empty, gets silently voided, and any real stakes on it are lost
-- with no human ever seeing it happen.
--
-- Now: a would-be-void market is marked 'pending_void' instead of
-- 'voided', an admin_alert notification fires, and nothing is finalized
-- until an admin explicitly approves (→ voided) or rejects (→ back to
-- 'locked' for investigation / re-resolve) it via /api/admin/void-queue.

ALTER TABLE public.markets
  ADD COLUMN IF NOT EXISTS void_reason text,
  ADD COLUMN IF NOT EXISTS void_requested_at timestamptz;

NOTIFY pgrst, 'reload schema';

-- Merge free_bet_credits into bonus_balance.
--
-- Background: free_bet_credits was credited by First Bet Insurance refunds
-- but never deducted at bet-placement time, so it sat dormant. Folding it
-- into bonus_balance (which IS spendable) makes insurance pay out a real
-- usable balance and gives admins a single column to monitor.

UPDATE public.users
   SET bonus_balance = COALESCE(bonus_balance, 0) + COALESCE(free_bet_credits, 0)
 WHERE COALESCE(free_bet_credits, 0) > 0;

ALTER TABLE public.users
  DROP COLUMN IF EXISTS free_bet_credits;

-- trg_users_bonus_expires / set_bonus_expires_at.
--
-- The bug reported in production: "bonuses are not expiring properly — when
-- I issue a new bonus the old one comes back." Root cause: the trigger
-- extended bonus_expires_at on any increase in bonus_balance, but never
-- checked whether the balance being increased FROM had already expired —
-- only the staking RPCs (place_bet, place_bet_locked, place_multiplier_slip)
-- ever zero out a stale balance, and only at the moment of a bet. Every other
-- credit path (admin manual credit via credit_user, referral bonuses, signup
-- promos, VIP preloads) just adds to the column as-is, so a dead, already-
-- expired balance came back to life — with a brand new 7-day window —
-- the instant any fresh bonus credit landed on top of it.
\set ON_ERROR_STOP on
\pset pager off

CREATE OR REPLACE FUNCTION pg_temp.check(label text, ok boolean, detail text DEFAULT '')
RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  IF ok THEN RAISE NOTICE 'PASS  %  %', rpad(label, 58), detail;
  ELSE        RAISE WARNING 'FAIL  %  %', rpad(label, 58), detail;
  END IF;
END$$;

DO $t$
DECLARE
  u uuid := '11111111-1111-1111-1111-111111111111';
  w uuid := '22222222-2222-2222-2222-222222222222';
  v_row record;
BEGIN
  INSERT INTO public.users(id,email,username,tngn_balance,bonus_balance)
  VALUES (u,'a@x.com','alpha',0,0), (w,'b@x.com','bravo',0,0);

  ------------------------------------------------------------ fresh credit
  PERFORM public.credit_user(u, 0, 5000);
  SELECT bonus_balance, bonus_expires_at INTO v_row FROM public.users WHERE id = u;
  PERFORM pg_temp.check('a fresh credit sets bonus_balance',
    v_row.bonus_balance = 5000, v_row.bonus_balance::text);
  PERFORM pg_temp.check('a fresh credit stamps a ~7-day expiry',
    v_row.bonus_expires_at > now() + interval '6 days 23 hours'
    AND v_row.bonus_expires_at <= now() + interval '7 days 1 minute');

  ------------------------------------------------------- the reported bug
  -- Force the existing bonus into the past, exactly as if 7+ days had
  -- genuinely elapsed with no bet placed since (nothing but a bet placement
  -- zeroes bonus_balance itself — the column stays 5000 the whole time).
  UPDATE public.users SET bonus_expires_at = now() - interval '1 day' WHERE id = u;

  -- Admin issues a brand new ₦2,000 bonus, via the exact RPC /api/admin/credits
  -- uses.
  PERFORM public.credit_user(u, 0, 2000);
  SELECT bonus_balance, bonus_expires_at INTO v_row FROM public.users WHERE id = u;

  PERFORM pg_temp.check('an expired balance is NOT carried into a new credit',
    v_row.bonus_balance = 2000,
    'got ' || v_row.bonus_balance::text || ' — the old ₦5,000 came back if this is 7000');
  PERFORM pg_temp.check('the new credit still gets its own 7-day window',
    v_row.bonus_expires_at > now() + interval '6 days 23 hours');

  ------------------------------------------------- a live (unexpired) top-up
  -- The normal case must be unaffected: crediting on top of a balance that
  -- has NOT yet expired stacks, and extends the window — it does not discard
  -- anything.
  UPDATE public.users SET bonus_balance = 1000, bonus_expires_at = now() + interval '3 days' WHERE id = w;
  PERFORM public.credit_user(w, 0, 500);
  SELECT bonus_balance, bonus_expires_at INTO v_row FROM public.users WHERE id = w;
  PERFORM pg_temp.check('a top-up on a still-live balance stacks, not discards',
    v_row.bonus_balance = 1500, v_row.bonus_balance::text);
  PERFORM pg_temp.check('a top-up on a still-live balance extends the window',
    v_row.bonus_expires_at > now() + interval '6 days 23 hours');

  ------------------------------------------------------------- no expiry set
  -- A balance with bonus_expires_at NULL (legacy, or a row the trigger never
  -- touched) is never treated as "expired" — only an explicit past timestamp
  -- counts.
  INSERT INTO public.users(id,email,username,tngn_balance,bonus_balance)
  VALUES ('33333333-3333-3333-3333-333333333333','c@x.com','charlie',0,0);
  PERFORM public.credit_user('33333333-3333-3333-3333-333333333333', 0, 100);
  SELECT bonus_balance, bonus_expires_at INTO v_row
    FROM public.users WHERE id = '33333333-3333-3333-3333-333333333333';
  PERFORM pg_temp.check('no prior expiry means nothing to discard',
    v_row.bonus_balance = 100, v_row.bonus_balance::text);

  ---------------------------------------------------- a debit is untouched
  -- credit_user with a negative delta (e.g. a void reclaiming bonus stake)
  -- decreases the balance — the "increase" branch, and this fix, must never
  -- fire on a decrease.
  UPDATE public.users SET bonus_balance = 500, bonus_expires_at = now() - interval '1 day'
   WHERE id = u;
  PERFORM public.credit_user(u, 0, -200);
  SELECT bonus_balance INTO v_row FROM public.users WHERE id = u;
  PERFORM pg_temp.check('a decrease is never mistaken for a stale-balance credit',
    v_row.bonus_balance = 300, v_row.bonus_balance::text);
END
$t$;

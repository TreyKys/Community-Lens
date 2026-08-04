-- ============================================================================
-- Bonus-proportion slip audit (READ ONLY — makes no changes)
-- ============================================================================
-- Context: migration 20260710010000 accidentally redefined
-- place_multiplier_slip without bonus tracking, so any Multiplier SLIP
-- placed while that version was live got bonus_proportion = 0 recorded
-- (NOT NULL DEFAULT 0), which makes settlement pay winnings/void refunds
-- 100% to withdrawable cash instead of splitting to bonus. Migration
-- 20260714000000 restores the correct function.
--
-- IMPORTANT: single bets (place_bet / place_bet_locked) were NEVER
-- affected — this is Multiplier slips only.
--
-- Run each STEP in the Supabase SQL editor (or psql) against PRODUCTION.
-- Nothing here writes; it only reports.
-- ============================================================================


-- ── STEP 1 — Are you even affected? ─────────────────────────────────────────
-- If the live place_multiplier_slip mentions bonus_proportion, you are NOT
-- affected: the bonus-aware version is (or is again) live and every slip has
-- a correct proportion. If FALSE, the regressed version is live and slips
-- placed under it are corrupted — apply 20260714000000, then continue below.
SELECT
  (p.prosrc LIKE '%bonus_proportion%') AS bonus_tracking_live,
  (p.prosrc LIKE '%bonus_expires_at%') AS bonus_expiry_live
FROM pg_proc p
JOIN pg_namespace n ON n.oid = p.pronamespace
WHERE n.nspname = 'public' AND p.proname = 'place_multiplier_slip';


-- ── STEP 2 — Candidate at-risk slips ────────────────────────────────────────
-- Slips stamped bonus_proportion = 0 whose OWNER has actually touched bonus
-- (currently holds bonus, or was ever granted bonus). A genuinely all-cash
-- slip is also 0 — the data to tell them apart with certainty was never
-- recorded — so treat this as a REVIEW candidate list, not a certainty.
--
-- Set the cutoff to roughly when 20260710010000 went live in prod (the
-- window during which slips could have been corrupted). Widen it if unsure;
-- narrowing to real bonus-touching users is what keeps the list meaningful.
WITH cutoff AS (SELECT TIMESTAMPTZ '2026-07-10 00:00:00+00' AS ts),  -- <-- EDIT ME
bonus_users AS (
  SELECT DISTINCT u.id
  FROM public.users u
  WHERE COALESCE(u.bonus_balance, 0) > 0
  UNION
  SELECT DISTINCT tl.user_id
  FROM public.treasury_log tl
  WHERE tl.type IN ('welcome_match', 'admin_credit', 'weekly_rebate', 'bonus_grant')
)
SELECT
  s.id                AS slip_id,
  s.user_id,
  s.status,                              -- active | won | lost | voided
  s.slip_stake_tngn,
  s.net_slip_stake_tngn,
  s.payout_tngn,
  s.created_at        AS placed_at
FROM public.multiplier_slips s
JOIN bonus_users bu ON bu.id = s.user_id
WHERE COALESCE(s.bonus_proportion, 0) = 0
  AND s.created_at >= (SELECT ts FROM cutoff)
ORDER BY s.status, s.created_at;


-- ── STEP 3 — Bounded house exposure ─────────────────────────────────────────
-- The WORST-CASE bonus→cash leak, assuming every candidate slip was fully
-- bonus-funded (the max mis-split). Real exposure is <= these numbers.
--   * won slips: up to 90% of the payout was paid as cash instead of bonus.
--   * lost slips: no payout, so NO leak regardless of proportion — listed
--     only for completeness (exposure 0).
--   * active slips: contingent — leaks only IF they win. Resolve them under
--     the FIXED function (apply 20260714000000 first) and only those still
--     carrying proportion=0 at settlement can leak.
WITH cutoff AS (SELECT TIMESTAMPTZ '2026-07-10 00:00:00+00' AS ts),   -- <-- match STEP 2
bonus_users AS (
  SELECT DISTINCT u.id FROM public.users u WHERE COALESCE(u.bonus_balance,0) > 0
  UNION
  SELECT DISTINCT tl.user_id FROM public.treasury_log tl
  WHERE tl.type IN ('welcome_match','admin_credit','weekly_rebate','bonus_grant')
),
cand AS (
  SELECT s.status, s.payout_tngn
  FROM public.multiplier_slips s
  JOIN bonus_users bu ON bu.id = s.user_id
  WHERE COALESCE(s.bonus_proportion,0) = 0
    AND s.created_at >= (SELECT ts FROM cutoff)
)
SELECT
  status,
  count(*)                                              AS slips,
  round(sum(CASE WHEN status = 'won'
                 THEN COALESCE(payout_tngn,0) * 0.90     -- max leak on a win
                 ELSE 0 END), 2)                         AS max_bonus_to_cash_leak_tngn
FROM cand
GROUP BY status
ORDER BY status;

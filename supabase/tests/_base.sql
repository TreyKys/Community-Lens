-- Minimal stand-in for the parts of the production schema the Open Markets
-- engine touches. Deliberately mirrors the real column names and the real
-- clamping behaviour of credit_user (GREATEST(0, ...)), because that clamp is
-- what makes credit_user unsafe as a debit and the engine is built around it.
CREATE SCHEMA auth;
CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE TABLE auth.users(id uuid primary key);
CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$SELECT NULL::uuid$$;
CREATE FUNCTION auth.role() RETURNS text LANGUAGE sql STABLE AS $$SELECT 'service_role'::text$$;

CREATE TABLE public.users(
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email text, username text, is_vip boolean DEFAULT false,
  tngn_balance numeric DEFAULT 0, bonus_balance numeric DEFAULT 0,
  created_at timestamptz DEFAULT now(),
  CONSTRAINT users_balances_nonneg
    CHECK (COALESCE(tngn_balance,0) >= 0 AND COALESCE(bonus_balance,0) >= 0)
);

CREATE TABLE public.treasury_log(
  id bigserial PRIMARY KEY, type text, amount_tngn numeric,
  user_id uuid, metadata jsonb, created_at timestamptz DEFAULT now());

CREATE TABLE public.notifications(
  id bigserial PRIMARY KEY, user_id uuid, type text, message text,
  created_at timestamptz DEFAULT now());

CREATE TABLE public.house_reserve(
  id smallint PRIMARY KEY DEFAULT 1,
  total_tngn numeric DEFAULT 0, floor_tngn numeric DEFAULT 0,
  updated_at timestamptz DEFAULT now());
INSERT INTO public.house_reserve(id,total_tngn,floor_tngn) VALUES (1,2000000,200000);

CREATE VIEW public.reserve_health AS
SELECT total_tngn, floor_tngn,
       GREATEST(0, total_tngn - floor_tngn) AS deployable_tngn,
       CASE WHEN floor_tngn > 0 THEN GREATEST(0, total_tngn - floor_tngn)/floor_tngn ELSE 0 END AS health_ratio,
       updated_at
  FROM public.house_reserve WHERE id = 1;

-- Clamps at zero exactly like production. This is why the trade path debits
-- inline under the user lock instead of calling this.
CREATE FUNCTION public.credit_user(p_user_id uuid, p_tngn_delta numeric, p_bonus_delta numeric)
RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  UPDATE public.users
     SET tngn_balance  = GREATEST(0, COALESCE(tngn_balance,0)  + p_tngn_delta),
         bonus_balance = GREATEST(0, COALESCE(bonus_balance,0) + p_bonus_delta)
   WHERE id = p_user_id;
END$$;

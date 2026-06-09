-- Owner accounts: private allow-list of UIDs that get house-funded "shadow"
-- bets. Other users see nothing unusual — the market pool they observe is
-- untouched by owner activity. Owner stakes never touch tngn_balance/
-- bonus_balance and never enter pool_by_outcome; on resolution the owner is
-- paid directly by the house at the public market odds × (1 + win_boost_pct).
--
-- WHY a table (not env var, not boolean on users):
--   - Adding/removing an owner = one INSERT; no redeploy.
--   - Per-owner tuning (win_boost_pct) without code churn.
--   - One spot to audit who's privileged + when granted.
--   - RLS-locked + no policies => service role only; never reachable from
--     the public PostgREST surface or anon client.
--
-- TO grant (run via SQL editor with service role):
--   insert into public.owner_accounts (user_id, notes) values
--     ('<your-uid>', 'founder');
--
-- TO tune:
--   update public.owner_accounts set win_boost_pct = 0.50 where user_id = '...';
--
-- TO revoke (soft):
--   update public.owner_accounts set active = false where user_id = '...';
--
-- TO revoke (hard):
--   delete from public.owner_accounts where user_id = '...';

create table if not exists public.owner_accounts (
  user_id        uuid        primary key references public.users(id) on delete cascade,
  -- Multiplier applied on TOP of the public payout when the owner wins.
  -- 0.25 means owner receives 125% of what a normal user with the same
  -- stake on the same outcome would have received.
  win_boost_pct  numeric     not null default 0.25 check (win_boost_pct >= 0 and win_boost_pct <= 5),
  -- Kill switch — flips owner back to normal behavior without losing the
  -- row (so historical owner_activity stays joined).
  active         boolean     not null default true,
  notes          text,
  created_at     timestamptz not null default now()
);

-- Lock the table behind RLS with no policies => only service role can read
-- or write. Anon/auth roles get zero visibility, which is the whole point.
alter table public.owner_accounts enable row level security;
revoke all on public.owner_accounts from anon, authenticated;

-- Flag column on user_bets so settlement / analytics can tell shadow bets
-- apart from real ones without an extra join on every row.
alter table public.user_bets
  add column if not exists is_shadow_bet boolean not null default false;

-- Odds snapshot at placement. NULL for normal bets (we don't need it — they
-- settle pro-rata against the realized pool). Populated for shadow bets so
-- the owner is paid the odds they SAW when they placed the bet, not the
-- odds at resolution after the pool moved. Stake × odds_snapshot × (1+boost)
-- = payout. Stored as a numeric multiplier (e.g. 2.4 means stake × 2.4).
alter table public.user_bets
  add column if not exists odds_snapshot numeric;

-- Partial index — shadow bets are a tiny minority; index only those rows so
-- the index stays small and `where is_shadow_bet = true` filters are O(log n).
create index if not exists user_bets_shadow_idx
  on public.user_bets (user_id, market_id)
  where is_shadow_bet = true;

-- Admin-only monitoring view. Joining owner_accounts means non-owner bets
-- never appear here, and the underlying RLS on owner_accounts means anon
-- queries return empty.
create or replace view public.owner_activity as
select
  b.id            as bet_id,
  b.user_id,
  b.market_id,
  b.outcome_index,
  b.stake_tngn,
  b.net_stake_tngn,
  b.payout_tngn,
  b.status,
  b.is_shadow_bet,
  b.placed_at
from public.user_bets b
join public.owner_accounts oa on oa.user_id = b.user_id;

revoke all on public.owner_activity from anon, authenticated;

-- ── place_shadow_bet RPC ──────────────────────────────────────────────────
-- Parallels public.place_bet (see 20240614000000_vip_referrals_points_terms.sql),
-- but with three deliberate omissions:
--   1. No user balance deduction (house funds the stake).
--   2. No update to markets.total_pool / pool_by_outcome (so other users see
--      no perturbation in the pool — the entire point of "shadow").
--   3. No treasury rake row and no leaderboard points (would either pollute
--      house revenue numbers or surface owner UIDs publicly).
--
-- Returns odds_snapshot — the multiplier that will be applied at settlement.
-- Fixing odds at placement (vs. recomputing at resolution) means the owner
-- gets the same expected payout they SAW in the UI when they placed the bet,
-- independent of how the public pool drifts afterwards.
create or replace function public.place_shadow_bet(
  p_user_id        uuid,
  p_market_id      bigint,
  p_outcome_index  integer,
  p_stake_tngn     numeric
)
returns table (
  bet_id              uuid,
  net_stake           numeric,
  odds_snapshot       numeric,
  is_jackpot_eligible boolean
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_min_stake      constant numeric := 100;
  v_jackpot_min    constant numeric := 500;
  v_market         record;
  v_options_len    int;
  v_bet_id         uuid;
  v_jackpot        boolean;
  v_pool_key       text;
  v_outcome_pool   numeric;
  v_total_pool     numeric;
  v_odds           numeric;
  v_active_owner   boolean;
begin
  if p_user_id is null or p_market_id is null
     or p_outcome_index is null or p_stake_tngn is null then
    raise exception 'invalid_input' using errcode = 'P0001';
  end if;
  if p_stake_tngn < v_min_stake then
    raise exception 'stake_below_minimum' using errcode = 'P0001';
  end if;

  -- Defence in depth: even if the TS route is bypassed, this RPC refuses
  -- to settle for a non-owner. owner_accounts is locked behind RLS so the
  -- check uses SECURITY DEFINER's read access.
  select active into v_active_owner
    from public.owner_accounts where user_id = p_user_id;
  if not found or not v_active_owner then
    raise exception 'not_an_owner' using errcode = 'P0001';
  end if;

  select id, status, closes_at, options, total_pool, pool_by_outcome
    into v_market
    from public.markets where id = p_market_id for update;

  if not found then raise exception 'market_not_found' using errcode = 'P0002'; end if;
  if v_market.status <> 'open' then raise exception 'market_not_open' using errcode = 'P0001'; end if;
  if v_market.closes_at <= now() then raise exception 'market_closed' using errcode = 'P0001'; end if;

  v_options_len := jsonb_array_length(v_market.options);
  if p_outcome_index < 0 or p_outcome_index >= v_options_len then
    raise exception 'invalid_outcome' using errcode = 'P0001';
  end if;

  -- Compute odds as if the stake DID enter the pool. This way a sole bettor
  -- on a side gets ~1× back (not infinity); a heavy-favoured side gets less;
  -- a lightly-backed side gets more — exactly the parimutuel curve the UI
  -- shows. The 0.9 mirrors the 10% house rake applied at resolution to
  -- real bettors, so the displayed odds match.
  v_pool_key     := p_outcome_index::text;
  v_outcome_pool := coalesce((v_market.pool_by_outcome ->> v_pool_key)::numeric, 0) + p_stake_tngn;
  v_total_pool   := coalesce(v_market.total_pool, 0) + p_stake_tngn;
  v_odds         := (v_total_pool * 0.9) / v_outcome_pool;

  v_jackpot := p_stake_tngn >= v_jackpot_min;

  insert into public.user_bets (
    user_id, market_id, outcome_index,
    stake_tngn, net_stake_tngn, entry_rake_tngn,
    is_jackpot_eligible, status, placed_at,
    is_shadow_bet, odds_snapshot
  ) values (
    p_user_id, p_market_id, p_outcome_index,
    p_stake_tngn, p_stake_tngn, 0,
    v_jackpot, 'active', now(),
    true, v_odds
  ) returning id into v_bet_id;

  return query select v_bet_id, p_stake_tngn, v_odds, v_jackpot;
end;
$$;

revoke all on function public.place_shadow_bet(uuid, bigint, integer, numeric) from public;

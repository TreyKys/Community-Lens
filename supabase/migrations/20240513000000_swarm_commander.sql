-- Phase 1 Bot Swarm Load Test Migration

-- 1. Add bot tracking columns to users
ALTER TABLE public.users
ADD COLUMN IF NOT EXISTS is_bot boolean DEFAULT false,
ADD COLUMN IF NOT EXISTS bot_cohort text,
ADD COLUMN IF NOT EXISTS bot_behavior text,
ADD COLUMN IF NOT EXISTS total_volume_traded numeric DEFAULT 0;

-- 2. Add Postgres CHECK constraints to prevent negative balances
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'tngn_balance_non_negative') THEN
        ALTER TABLE public.users ADD CONSTRAINT tngn_balance_non_negative CHECK (tngn_balance >= 0);
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'bonus_balance_non_negative') THEN
        ALTER TABLE public.users ADD CONSTRAINT bonus_balance_non_negative CHECK (bonus_balance >= 0);
    END IF;
END $$;

-- Track split logic in user_bets
ALTER TABLE public.user_bets
ADD COLUMN IF NOT EXISTS real_stake_tngn numeric DEFAULT 0,
ADD COLUMN IF NOT EXISTS bonus_stake_tngn numeric DEFAULT 0;

-- 3. Swarm Test Reports Table
CREATE TABLE IF NOT EXISTS public.swarm_test_reports (
    id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
    test_type text NOT NULL,
    status text NOT NULL,
    total_tx_attempted integer DEFAULT 0,
    total_tx_logged integer DEFAULT 0,
    peak_latency_ms numeric,
    invariant_check_passed boolean,
    edge_cases_passed boolean,
    report_data jsonb,
    created_at timestamptz DEFAULT now()
);

-- 4. Create an atomic RPC function for bet placement
CREATE OR REPLACE FUNCTION place_bet(
    p_user_id uuid,
    p_market_id bigint,
    p_outcome_index integer,
    p_stake_amount numeric,
    p_entry_rake numeric,
    p_is_jackpot_eligible boolean,
    p_placed_at timestamptz DEFAULT now()
) RETURNS jsonb AS $$
DECLARE
    v_user record;
    v_market record;
    v_net_stake numeric;
    v_new_real_balance numeric;
    v_new_bonus_balance numeric;
    v_bet_id uuid;
    v_remaining numeric;
    v_total_volume numeric;
    v_real_used numeric := 0;
    v_bonus_used numeric := 0;
BEGIN
    -- 1. Lock the user row for update to prevent concurrent modification
    SELECT id, tngn_balance, bonus_balance, total_volume_traded
    INTO v_user
    FROM public.users
    WHERE id = p_user_id
    FOR UPDATE;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'User not found';
    END IF;

    -- 2. Verify total balance
    IF (COALESCE(v_user.tngn_balance, 0) + COALESCE(v_user.bonus_balance, 0)) < p_stake_amount THEN
        RAISE EXCEPTION 'Insufficient balance';
    END IF;

    -- 3. Lock market for update to prevent closing race conditions
    SELECT id, status, closes_at
    INTO v_market
    FROM public.markets
    WHERE id = p_market_id
    FOR UPDATE;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'Market not found';
    END IF;

    IF v_market.status != 'open' THEN
        RAISE EXCEPTION 'Market is not open';
    END IF;

    IF v_market.closes_at < now() THEN
        RAISE EXCEPTION 'Market betting period has ended';
    END IF;

    -- 4. Calculate deduction logic (real first, then bonus)
    v_new_real_balance := COALESCE(v_user.tngn_balance, 0);
    v_new_bonus_balance := COALESCE(v_user.bonus_balance, 0);

    IF v_new_real_balance >= p_stake_amount THEN
        v_new_real_balance := v_new_real_balance - p_stake_amount;
        v_real_used := p_stake_amount;
    ELSE
        v_remaining := p_stake_amount - v_new_real_balance;
        v_real_used := v_new_real_balance;
        v_new_real_balance := 0;

        v_new_bonus_balance := v_new_bonus_balance - v_remaining;
        v_bonus_used := v_remaining;
    END IF;

    v_net_stake := p_stake_amount - p_entry_rake;

    -- 5. Track total volume (used for human rollover unlocking, and tracking bot activity)
    v_total_volume := COALESCE(v_user.total_volume_traded, 0) + p_stake_amount;

    -- 6. Update user balance
    UPDATE public.users
    SET
        tngn_balance = v_new_real_balance,
        bonus_balance = v_new_bonus_balance,
        total_volume_traded = v_total_volume
    WHERE id = p_user_id;

    -- 7. Insert the bet
    INSERT INTO public.user_bets (
        user_id,
        market_id,
        outcome_index,
        stake_tngn,
        net_stake_tngn,
        entry_rake_tngn,
        is_jackpot_eligible,
        real_stake_tngn,
        bonus_stake_tngn,
        status,
        placed_at
    ) VALUES (
        p_user_id,
        p_market_id,
        p_outcome_index,
        p_stake_amount,
        v_net_stake,
        p_entry_rake,
        p_is_jackpot_eligible,
        v_real_used,
        v_bonus_used,
        'active',
        p_placed_at
    ) RETURNING id INTO v_bet_id;

    -- 8. Insert treasury log
    INSERT INTO public.treasury_log (
        type,
        amount_tngn,
        bet_id,
        market_id,
        user_id,
        created_at
    ) VALUES (
        'entry_rake',
        p_entry_rake,
        v_bet_id,
        p_market_id,
        p_user_id,
        p_placed_at
    );

    RETURN jsonb_build_object(
        'success', true,
        'bet_id', v_bet_id,
        'new_tngn_balance', v_new_real_balance,
        'new_bonus_balance', v_new_bonus_balance
    );
EXCEPTION WHEN OTHERS THEN
    -- If anything fails, log it and re-raise (the transaction will automatically roll back)
    INSERT INTO public.error_log (type, user_id, amount, created_at)
    VALUES ('place_bet_rpc_failed: ' || SQLERRM, p_user_id, p_stake_amount, now());
    RAISE;
END;
$$ LANGUAGE plpgsql;

-- Notify pgrst to reload the schema cache
NOTIFY pgrst, 'reload schema';

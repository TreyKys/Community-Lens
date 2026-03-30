CREATE TABLE IF NOT EXISTS user_bets (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  wallet_address text NOT NULL,
  market_id text NOT NULL,
  market_title text NOT NULL,
  outcome text NOT NULL,
  staked_amount numeric NOT NULL,
  status text DEFAULT 'Pending',
  created_at timestamp with time zone DEFAULT timezone('utc'::text, now()) NOT NULL
);

-- Note: RLS policies should be carefully applied
ALTER TABLE user_bets ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Allow anonymous read access to bets"
ON user_bets FOR SELECT
TO anon, authenticated
USING (true);

CREATE POLICY "Allow anonymous insert access to bets"
ON user_bets FOR INSERT
TO anon, authenticated
WITH CHECK (true);

-- For the sake of the bot/admin reading/updating, bypass RLS or use a specific role.

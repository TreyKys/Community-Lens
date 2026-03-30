CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

CREATE TABLE users (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    email VARCHAR(255) UNIQUE,
    phone VARCHAR(20) UNIQUE,
    wallet_address VARCHAR(42) NOT NULL,
    tngn_balance DECIMAL(18, 2) DEFAULT 0,
    free_bet_credits DECIMAL(18, 2) DEFAULT 0,
    is_custodial BOOLEAN DEFAULT TRUE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE TABLE markets (
    id VARCHAR(255) PRIMARY KEY,
    question TEXT NOT NULL,
    options JSONB NOT NULL,
    closes_at TIMESTAMP WITH TIME ZONE NOT NULL,
    status VARCHAR(50) DEFAULT 'open', -- open, closed, resolved
    winning_outcome VARCHAR(255),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE TABLE user_bets (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id UUID REFERENCES users(id),
    market_id VARCHAR(255) REFERENCES markets(id),
    outcome VARCHAR(255) NOT NULL,
    staked_amount DECIMAL(18, 2) NOT NULL,
    status VARCHAR(50) DEFAULT 'pending', -- pending, won, lost
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE TABLE merkle_commits (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    market_id VARCHAR(255) REFERENCES markets(id),
    merkle_root VARCHAR(66) NOT NULL,
    tx_hash VARCHAR(66),
    committed_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE TABLE transactions (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id UUID REFERENCES users(id),
    type VARCHAR(50) NOT NULL, -- deposit, withdraw, bet_placed, bet_won, withdraw_fee
    amount DECIMAL(18, 2) NOT NULL,
    currency VARCHAR(10) NOT NULL, -- tNGN, NGN
    conversion_rate DECIMAL(18, 4),
    status VARCHAR(50) DEFAULT 'pending', -- pending, completed, failed
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

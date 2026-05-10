-- Adds a long-form `description` column to markets so the AI generator can
-- store the "why it works" rationale alongside the question, and a
-- `resolved_at` column so the UI can soft-hide resolved markets older than 26h
-- (without deleting any data — audit trail, user_bets and treasury rows stay intact).

alter table markets
  add column if not exists description text,
  add column if not exists resolved_at timestamptz;

-- Backfill resolved_at for already-resolved markets so they aren't shown
-- forever after this lands. We don't know exactly when each one resolved, so
-- approximate with closes_at (close enough — they were resolved soon after).
update markets
  set resolved_at = closes_at
  where status = 'resolved'
    and resolved_at is null;

-- Index used by the public market list to filter out old resolved markets fast.
create index if not exists idx_markets_status_resolved_at
  on markets (status, resolved_at);

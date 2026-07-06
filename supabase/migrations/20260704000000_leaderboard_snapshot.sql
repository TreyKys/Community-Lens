-- The public leaderboard used to recompute leaderboard_points() live on
-- every anonymous request. Per admin decision, the public board now
-- shows only what an admin has explicitly published — admins still see
-- the live standings via /api/admin/leaderboard, and push a snapshot
-- to the public board at will from /admin.

create table if not exists public.leaderboard_snapshot (
  window text primary key check (window in ('daily', 'weekly', 'alltime')),
  since timestamptz,
  rows jsonb not null default '[]'::jsonb,
  published_at timestamptz not null default now(),
  published_by text
);

alter table public.leaderboard_snapshot enable row level security;

drop policy if exists "Leaderboard snapshot viewable by everyone" on public.leaderboard_snapshot;
create policy "Leaderboard snapshot viewable by everyone"
  on public.leaderboard_snapshot for select
  using (true);

-- No insert/update/delete policy for anon/authenticated — every write
-- goes through the service-role client in
-- /api/admin/leaderboard/publish, which is gated by isAdminRequest().

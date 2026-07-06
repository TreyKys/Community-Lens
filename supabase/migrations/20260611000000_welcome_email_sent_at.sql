-- Track when the post-signup welcome email landed so we don't re-mail
-- users when /api/user/accept-terms re-fires (T&C version bumps, or the
-- onboarding modal re-opening). lib/welcome-email.ts gates on this.

ALTER TABLE public.users
  ADD COLUMN IF NOT EXISTS welcome_email_sent_at timestamptz;

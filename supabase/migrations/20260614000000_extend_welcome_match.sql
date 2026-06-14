-- Extend the Welcome Match cutoff.
--
-- The original launch promo (20260608120000_launch_signup_promo.sql) was
-- set to expire 2026-06-20 23:59:59+01 — a 12-day window aligned to the
-- pre-launch X Ads campaign. We're now running organic + influencer
-- acquisition on a longer arc, so the "100% deposit match up to ₦1,000"
-- offer needs to survive past June 20 or the headline marketing line
-- evaporates mid-campaign.
--
-- This is a no-op for the rest of the system — claim_welcome_match() and
-- the singleton config row are unchanged. We just bump the cutoff.

UPDATE public.launch_promo
   SET cutoff = '2026-08-31 23:59:59+01'
 WHERE id = 1;

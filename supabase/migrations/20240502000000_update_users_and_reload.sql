-- Add fields for Web2 onboarding (Name, DOB, Phone) to users table
ALTER TABLE public.users
ADD COLUMN IF NOT EXISTS first_name text,
ADD COLUMN IF NOT EXISTS dob date,
ADD COLUMN IF NOT EXISTS phone text;

-- Notify pgrst to reload the schema cache so public_market_metadata and new columns are picked up
NOTIFY pgrst, 'reload schema';

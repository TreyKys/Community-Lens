import { createClient } from '@supabase/supabase-js';

// These are safe to expose publicly — they only grant anon-level access.
// RLS policies on every table control what anon users can actually read/write.

export function getSupabase() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !key) {
    if (process.env.NODE_ENV === 'production' && typeof window !== 'undefined') {
      console.error('Missing Supabase environment variables.');
    }
    return null;
  }
  return createClient(url, key);
}

// Client components that rely on the supabase export should handle null or mock it
// if it evaluates to null during build time.
export const supabase = getSupabase() || createClient('https://mock.supabase.co', 'mock-key');

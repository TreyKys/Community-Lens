import { createClient } from '@supabase/supabase-js';

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL || 'https://hgpmpihsdmkhdupmgbal.supabase.co';
const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || 'sb_publishable_csVoPnJb0852z9rHXrhG7A_ISh-3-mK';

export const supabase = createClient(supabaseUrl, supabaseAnonKey);
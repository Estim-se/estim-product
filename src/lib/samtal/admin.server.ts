// Service-role client typed with the staged Samtal schema (see db-types.ts).
// Same client instance as the shared admin client; only the type differs.
import type { SupabaseClient } from '@supabase/supabase-js';
import { supabaseAdmin as shared } from '@/integrations/supabase/client.server';
import type { Database } from '@/lib/samtal/db-types';

export const supabaseAdmin = shared as unknown as SupabaseClient<Database>;

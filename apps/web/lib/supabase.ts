import { createBrowserClient } from "@supabase/ssr";
import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * Browser-only Supabase client. Uses cookies (via @supabase/ssr) so the same
 * session is visible to middleware — plain createClient() used localStorage only,
 * which caused sign-in to succeed in the UI but /dashboard to stay blocked.
 */
export function getSupabaseClient(): SupabaseClient | null {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const supabaseKey =
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_KEY;

  if (!supabaseUrl || !supabaseKey) return null;
  if (typeof window === "undefined") return null;

  return createBrowserClient(supabaseUrl, supabaseKey);
}

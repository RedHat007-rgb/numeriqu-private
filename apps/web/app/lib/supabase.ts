import { createClient, SupabaseClient } from '@supabase/supabase-js';

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;

/**
 * PRODUCTION-GRADE SUPABASE CLIENT (SINGLETON)
 * 
 * Contention Mitigation:
 * 1. Uses a unique 'storageKey' to isolate Numeriqu from other local apps.
 * 2. Implements request deduplication via the singleton pattern.
 * 3. Standardizes on 'localStorage' for broad browser compatibility.
 */
let _supabase: SupabaseClient | null = null;
let _session: any = null;

function getSupabase(): SupabaseClient {
  if (!_supabase) {
    _supabase = createClient(supabaseUrl, supabaseAnonKey, {
      auth: {
        persistSession: true,
        autoRefreshToken: true,
        detectSessionInUrl: true,
        storageKey: 'numeriqu-auth-v1',
        flowType: 'pkce',
      },
      global: {
        headers: { 'x-application-name': 'numeriqu' },
      },
    });

    // Reactive session tracking to avoid storage lock contention
    _supabase.auth.onAuthStateChange((_event, session) => {
      _session = session;
    });
    
    // Initial fetch to prime the cache
    _supabase.auth.getSession().then(({ data: { session } }) => {
      _session = session;
    });
  }
  return _supabase;
}

export const supabase = getSupabase();

/**
 * Get the current session's access token for API calls.
 * Uses reactive cache to avoid Navigator Lock API contention.
 */
export async function getAccessToken(): Promise<string | null> {
  // If we already have it in memory, return it (Zero Latency, No Locks)
  if (_session?.access_token) {
    return _session.access_token;
  }

  try {
    // Fallback only if cache is empty (e.g. first load)
    const { data: { session }, error } = await supabase.auth.getSession();
    if (error) throw error;
    _session = session;
    return session?.access_token ?? null;
  } catch (e: any) {
    // Silently handle lock stealing errors as they are recovered by the fallback
    if (e.name === 'AbortError' || e.message?.includes('steal')) {
      return _session?.access_token ?? null;
    }
    console.error('[Auth] Token retrieval failed', e);
    return null;
  }
}

/**
 * Authenticated fetch wrapper — auto-attaches Bearer token.
 * This is the ONLY way frontend components should talk to the API.
 */
export async function apiFetch(path: string, options: RequestInit = {}): Promise<Response> {
  const token = await getAccessToken();
  const apiUrl = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3000';
  
  // Normalize path (ensure leading slash)
  const normalizedPath = path.startsWith('/') ? path : `/${path}`;
  const fullUrl = `${apiUrl}${normalizedPath}`;
  
  console.log(`[API CALL] ${options.method || 'GET'} ${fullUrl}`);
  
  try {
    const response = await fetch(fullUrl, {
      ...options,
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...options.headers,
      },
    });
    return response;
  } catch (error) {
    // Return a mocked Response with a user-friendly error payload instead of throwing a TypeError
    return new Response(
      JSON.stringify({ message: "Unable to connect to the financial intelligence server. Please check your network connection." }),
      { status: 503, headers: { 'Content-Type': 'application/json' } }
    );
  }
}

/**
 * Server-side Supabase client helper.
 *
 * SECURITY: SUPABASE_SERVICE_ROLE_KEY must NEVER reach frontend code. It is
 * read here (server process only) and used to create an admin client that
 * bypasses RLS. The web app talks to chat data exclusively through the
 * server's /api routes.
 *
 * When SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY are missing, local dev keeps
 * working: getSupabaseAdmin() returns null and the chat store falls back to
 * an in-memory implementation (see chat-store.ts).
 */
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

let cachedClient: SupabaseClient | null | undefined;
let warned = false;

export function isSupabaseConfigured(): boolean {
  return Boolean(process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY);
}

/** Admin client (service role) or null when env is not configured. Never throws. */
export function getSupabaseAdmin(): SupabaseClient | null {
  if (cachedClient !== undefined) return cachedClient;

  const url = process.env.SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!url || !serviceRoleKey) {
    if (!warned) {
      warned = true;
      console.warn(
        "[supabase] SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not set — chat history uses an in-memory store (lost on restart)."
      );
    }
    cachedClient = null;
    return null;
  }

  cachedClient = createClient(url, serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  return cachedClient;
}

/** Test hook: forget the cached client so env changes take effect. */
export function resetSupabaseClientForTests(): void {
  cachedClient = undefined;
  warned = false;
}

import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";
import type { Database } from "./database.types";

// The Supabase project address and its anon (publishable) key. Both are designed to be
// safe if seen; what protects the data is row-level security in the database.
export function supabaseEnv(): { url: string; key: string } | null {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_ANON_KEY;
  return url && key ? { url, key } : null;
}

// A Supabase connection for this request, acting as the signed-in visitor (from their
// session cookies), so the database's row-level security rules apply to everything it does.
// Create a new one for each request.
export async function createClient() {
  const env = supabaseEnv();
  if (!env) throw new Error("SUPABASE_URL and SUPABASE_ANON_KEY must be set.");
  const cookieStore = await cookies();

  return createServerClient<Database>(env.url, env.key, {
    cookies: {
      getAll() {
        return cookieStore.getAll();
      },
      setAll(cookiesToSet) {
        try {
          cookiesToSet.forEach(({ name, value, options }) => cookieStore.set(name, value, options));
        } catch {
          // Pages can't set cookies while rendering; proxy.ts keeps the session fresh instead.
        }
      },
    },
  });
}

// The signed-in user's id and email, or null for a signed-out visitor.
export async function currentUser(supabase: Awaited<ReturnType<typeof createClient>>) {
  const { data } = await supabase.auth.getClaims();
  const claims = data?.claims;
  return claims?.sub ? { id: claims.sub, email: (claims.email as string | undefined) ?? null } : null;
}

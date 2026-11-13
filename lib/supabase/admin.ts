import "server-only"; // the build fails if this file is ever pulled into browser code
import { createClient } from "@supabase/supabase-js";
import type { Database } from "./database.types";

// A Supabase connection with administrator rights (the service role key). It bypasses
// row-level security, so it's used for one thing only: deleting a signed-in user's own
// account, after the server has confirmed who they are. Never use it for anything else.
export function createAdminClient() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return null;
  return createClient<Database>(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
}

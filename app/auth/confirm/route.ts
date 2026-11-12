import type { EmailOtpType } from "@supabase/supabase-js";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";

// Where the magic link in the email lands. It checks the link with Supabase, which
// sets the session cookies, then sends the visitor home.
export async function GET(request: Request) {
  const params = new URL(request.url).searchParams;
  const code = params.get("code");
  const tokenHash = params.get("token_hash");
  const type = params.get("type") as EmailOtpType | null;

  const supabase = await createClient();
  let failed = true;
  if (tokenHash && type) {
    // Works even if the link is opened on a different device (needs the email template change).
    failed = Boolean((await supabase.auth.verifyOtp({ token_hash: tokenHash, type })).error);
  } else if (code) {
    // Supabase's default email link: only works in the browser that asked for it.
    failed = Boolean((await supabase.auth.exchangeCodeForSession(code)).error);
  }

  redirect(failed ? "/?signin_error=1" : "/");
}

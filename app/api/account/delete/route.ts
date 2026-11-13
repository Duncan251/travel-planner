import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient, currentUser } from "@/lib/supabase/server";

export const runtime = "nodejs";

// Deletes the signed-in user's account. Their profile, trips, messages and message counts
// are all linked to the account with "on delete cascade", so the database removes them
// in the same step.
export async function POST(req: Request) {
  const to = (path: string) => NextResponse.redirect(new URL(path, req.url), 303);

  const supabase = await createClient();
  const user = await currentUser(supabase);
  if (!user) return to("/");

  const form = await req.formData();
  if (String(form.get("confirm") ?? "").trim().toUpperCase() !== "DELETE") {
    return to("/account/delete?error=confirm");
  }

  const admin = createAdminClient();
  if (!admin) {
    console.error("Account deletion is unavailable: SUPABASE_SERVICE_ROLE_KEY is not set.");
    return to("/account/delete?error=failed");
  }

  // Only ever the id of the person who is signed in, taken from their verified session.
  const { error } = await admin.auth.admin.deleteUser(user.id);
  if (error) {
    console.error("Deleting account failed:", error.message);
    return to("/account/delete?error=failed");
  }
  console.log(`Account deleted: ${user.id}`);

  // Sign them out on this device and clear the sign-in cookies.
  await supabase.auth.signOut({ scope: "local" }).catch(() => {});
  const res = to("/?account_deleted=1");
  for (const cookie of req.headers.get("cookie")?.split(";") ?? []) {
    const name = cookie.split("=")[0].trim();
    if (name.startsWith("sb-")) res.cookies.delete(name);
  }
  return res;
}

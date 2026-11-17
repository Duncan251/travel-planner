import "server-only"; // the admin check must only ever run on the server
import { notFound } from "next/navigation";
import { createClient, currentUser } from "./supabase/server";

// The /admin page is for one account only: the one whose email is in ADMIN_EMAIL.
// The check runs on the server for every request, using the signed-in session verified by
// Supabase (a forged or edited cookie fails verification). Anyone else, signed in or not,
// gets the normal 404, before any admin data is loaded. If ADMIN_EMAIL isn't set, nobody is admin.

function normalise(email: string | null | undefined): string {
  return (email ?? "").trim().toLowerCase();
}

// Whether this email is the admin's. Used to decide (on the server) whether to include the
// Admin link in a page; the /admin page itself still checks with requireAdmin().
export function isAdminEmail(email: string | null | undefined): boolean {
  const adminEmail = normalise(process.env.ADMIN_EMAIL);
  return Boolean(adminEmail) && normalise(email) === adminEmail;
}

// Returns the admin's email, or shows "not found" for everyone else.
export async function requireAdmin(): Promise<string> {
  const adminEmail = normalise(process.env.ADMIN_EMAIL);
  if (!adminEmail) notFound();

  const supabase = await createClient();
  const user = await currentUser(supabase);
  if (!user || normalise(user.email) !== adminEmail) notFound();
  return adminEmail;
}

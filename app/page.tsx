import { redirect } from "next/navigation";
import { createClient, currentUser } from "@/lib/supabase/server";
import Chat from "./chat";
import Welcome from "./welcome";

// Signed-out visitors see the welcome page; signed-in users see the planner, after a
// one-time stop at the preferences page.
export default async function Home({ searchParams }: { searchParams: Promise<{ signin_error?: string }> }) {
  const supabase = await createClient();
  const user = await currentUser(supabase);
  if (!user) {
    const { signin_error } = await searchParams;
    return <Welcome linkFailed={Boolean(signin_error)} />;
  }

  // No profile row yet means this is their first visit: offer the preferences page once.
  const { data: profile } = await supabase.from("profiles").select("user_id").eq("user_id", user.id).maybeSingle();
  if (!profile) redirect("/preferences?first=1");

  return <Chat email={user.email} />;
}

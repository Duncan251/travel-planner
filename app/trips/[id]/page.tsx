import { notFound, redirect } from "next/navigation";
import { createClient, currentUser } from "@/lib/supabase/server";
import Chat from "../../chat";

// One saved trip: its whole conversation, ready to continue.
export default async function TripPage({ params }: { params: Promise<{ id: string }> }) {
  const supabase = await createClient();
  const user = await currentUser(supabase);
  if (!user) redirect("/");

  const { id } = await params;
  // Row-level security means someone else's trip simply isn't found.
  const { data: trip } = await supabase.from("trips").select("id, title").eq("id", id).maybeSingle();
  if (!trip) notFound();

  const { data: messages } = await supabase
    .from("trip_messages")
    .select("role, content")
    .eq("trip_id", trip.id)
    .order("id", { ascending: true });

  return <Chat email={user.email} tripId={trip.id} tripTitle={trip.title} initialMessages={messages ?? []} />;
}

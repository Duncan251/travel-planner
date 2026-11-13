"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { createClient, currentUser } from "@/lib/supabase/server";

const MAX_TITLE = 120;

// Renames a trip. From then on Katie leaves the name alone.
export async function renameTrip(formData: FormData) {
  const supabase = await createClient();
  if (!(await currentUser(supabase))) redirect("/");

  const id = String(formData.get("id") ?? "");
  const title = String(formData.get("title") ?? "").trim().slice(0, MAX_TITLE);
  if (!id || !title) return;

  // Row-level security makes sure only the owner's trip can change.
  const { error } = await supabase.from("trips").update({ title, title_set_by_user: true }).eq("id", id);
  if (error) console.error("Renaming trip failed:", error.message);
  revalidatePath("/trips");
}

// Deletes a trip and, through the database, all its messages.
export async function deleteTrip(formData: FormData) {
  const supabase = await createClient();
  if (!(await currentUser(supabase))) redirect("/");

  const id = String(formData.get("id") ?? "");
  if (!id) return;

  const { error } = await supabase.from("trips").delete().eq("id", id);
  if (error) console.error("Deleting trip failed:", error.message);
  revalidatePath("/trips");
}

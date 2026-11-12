"use server";

import { redirect } from "next/navigation";
import { MAX_PREFERENCE_LENGTH, PREFERENCE_FIELDS } from "@/lib/profile";
import type { Database } from "@/lib/supabase/database.types";
import { createClient, currentUser } from "@/lib/supabase/server";

// Saves the preferences form. Empty boxes are stored as "no preference".
export async function savePreferences(formData: FormData) {
  const supabase = await createClient();
  const user = await currentUser(supabase);
  if (!user) redirect("/");

  const row: Database["public"]["Tables"]["profiles"]["Insert"] = {
    user_id: user.id,
    updated_at: new Date().toISOString(),
  };
  for (const field of PREFERENCE_FIELDS) {
    const value = String(formData.get(field.column) ?? "").trim().slice(0, MAX_PREFERENCE_LENGTH);
    const allowed = !field.options || field.options.some((o) => o.value === value);
    row[field.column] = value && allowed ? value : null;
  }

  // Row-level security makes sure this can only ever write the user's own row.
  const { error } = await supabase.from("profiles").upsert(row, { onConflict: "user_id" });
  if (error) {
    console.error("Saving preferences failed:", error.message);
    redirect("/preferences?error=1");
  }
  redirect("/");
}

// "Skip for now": creates an empty profile so the page isn't shown automatically again.
export async function skipPreferences() {
  const supabase = await createClient();
  const user = await currentUser(supabase);
  if (!user) redirect("/");

  const { error } = await supabase
    .from("profiles")
    .upsert({ user_id: user.id }, { onConflict: "user_id", ignoreDuplicates: true });
  if (error) {
    console.error("Skipping preferences failed:", error.message);
    redirect("/preferences?first=1&error=1");
  }
  redirect("/");
}

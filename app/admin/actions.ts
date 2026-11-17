"use server";

import { revalidatePath } from "next/cache";
import { requireAdmin } from "@/lib/admin";
import { createAdminClient } from "@/lib/supabase/admin";

// Marks a support ticket as resolved. Checks it's the admin on every call, so the button
// can't be used by anyone else, even with a hand-made request.
export async function resolveTicket(formData: FormData) {
  await requireAdmin();
  const ticketNumber = Number(formData.get("ticket"));
  const admin = createAdminClient();
  if (!ticketNumber || !admin) return;

  const { error } = await admin
    .from("tickets")
    .update({ status: "resolved", resolved_at: new Date().toISOString() })
    .eq("ticket_number", ticketNumber)
    .eq("status", "open");
  if (error) console.error(`Resolving KT-${ticketNumber} failed:`, error.message);
  else console.log(`✅ Ticket KT-${ticketNumber} marked resolved from /admin`);
  revalidatePath("/admin");
}

import type Anthropic from "@anthropic-ai/sdk";
import type { Database } from "../supabase/database.types";
import type { createClient } from "../supabase/server";
import type { ToolOutput } from "./types";

// Lets Katie keep notes on the current trip (a running summary, the latest itinerary and a
// suggested name) so the trip can be picked up later without covering old ground.

const MAX_SUMMARY = 8000;
const MAX_ITINERARY = 30000;
const MAX_TITLE = 120;

export const saveTripProgressTool: Anthropic.Tool = {
  name: "save_trip_progress",
  description: `Save your notes on this trip so it can be picked up later, even weeks from now, without going over the same ground. The traveller doesn't see these notes; they're for you.

When to call it: at the end of any reply in which something new was decided or learned (an answer to one of your questions, a choice made, a preference for this trip), and every time you share a new or changed itinerary. You don't need to call it for small talk or when nothing has changed.

summary (always required): rewrite the whole summary each time so it stands alone, covering the full trip so far, not just the latest message. Keep it short and factual, under these headings:
- Trip basics: where, when, how long, who's going, budget
- Decisions made
- Questions already asked and answered (so you don't ask again)
- Open questions and things to come back to
- Current stage (1 to 5) and what comes next

itinerary (only when you've just shared one): the exact text of the itinerary as you showed it to the traveller, word for word, so it can be shown again identically later. Leave it out if you haven't shared a new or changed itinerary in this reply; the last saved one is kept.

title (optional): once you know the destination and rough dates, suggest a short name such as "Lisbon & Sintra · May 2027". If the traveller has renamed the trip themselves, your suggestion is ignored.`,
  eager_input_streaming: true,
  input_schema: {
    type: "object",
    properties: {
      summary: { type: "string", description: `The full trip summary so far, under the headings above (max ${MAX_SUMMARY} characters).` },
      itinerary: { type: "string", description: "The itinerary exactly as you just showed it, only if you shared a new or changed one." },
      title: { type: "string", description: `A short trip name, e.g. "Lisbon & Sintra · May 2027" (max ${MAX_TITLE} characters).` },
    },
    required: ["summary"],
    additionalProperties: false,
  },
};

// Returns the handler for one trip. It writes through the signed-in user's own connection,
// so row-level security still decides what it can change.
export function tripProgressHandler(supabase: Awaited<ReturnType<typeof createClient>>, tripId: string) {
  return async (input: unknown): Promise<ToolOutput> => {
    const { summary, itinerary, title } = (input ?? {}) as Record<string, unknown>;
    if (typeof summary !== "string" || !summary.trim()) {
      return { content: "Not saved: summary is required.", isError: true };
    }
    if (summary.length > MAX_SUMMARY) {
      return { content: `Not saved: the summary is over ${MAX_SUMMARY} characters. Make it shorter and try again.`, isError: true };
    }
    if (itinerary !== undefined && (typeof itinerary !== "string" || itinerary.length > MAX_ITINERARY)) {
      return { content: `Not saved: itinerary must be text under ${MAX_ITINERARY} characters.`, isError: true };
    }

    const changes: Database["public"]["Tables"]["trips"]["Update"] = {
      summary: summary.trim(),
      updated_at: new Date().toISOString(),
    };
    if (typeof itinerary === "string" && itinerary.trim()) changes.itinerary = itinerary.trim();

    const saved: string[] = ["summary"];
    if (changes.itinerary) saved.push("itinerary");

    // Only take Katie's name if the traveller hasn't chosen one.
    if (typeof title === "string" && title.trim()) {
      const { data: trip } = await supabase.from("trips").select("title_set_by_user").eq("id", tripId).maybeSingle();
      if (trip && !trip.title_set_by_user) {
        changes.title = title.trim().slice(0, MAX_TITLE);
        saved.push("title");
      }
    }

    const { error } = await supabase.from("trips").update(changes).eq("id", tripId);
    if (error) return { content: `Not saved: the database returned an error (${error.message}).`, isError: true };
    return { content: `Saved ${saved.join(", ")}.`, isError: false };
  };
}

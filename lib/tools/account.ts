import type Anthropic from "@anthropic-ai/sdk";
import { describePreferences, type Profile } from "../profile";
import type { createClient } from "../supabase/server";
import type { ToolOutput } from "./types";

// Read-only look at the signed-in person's own account, for the support assistant.
// It takes no input: whose account it reads is decided by the server from the verified
// sign-in session, never by Claude, and the queries run as that person, so row-level
// security limits them to their own rows as well.

export const getMyAccountTool: Anthropic.Tool = {
  name: "get_my_account",
  description:
    "Look up the signed-in person's own account: the names of their saved trips (with when each was started and last updated) and their saved travel preferences. Use it only when they ask about their own trips, preferences or account. It always returns the account of the person you're talking to and can't look up anyone else. If they aren't signed in, it says so.",
  input_schema: { type: "object", properties: {}, additionalProperties: false },
};

type Supabase = Awaited<ReturnType<typeof createClient>>;

// user is the verified signed-in user for this request, or null if signed out.
export function myAccountHandler(supabase: Supabase, user: { id: string } | null) {
  return async (): Promise<ToolOutput> => {
    if (!user) return { content: "Not signed in.", isError: false };

    const [trips, profile] = await Promise.all([
      supabase
        .from("trips")
        .select("title, created_at, updated_at")
        .eq("user_id", user.id)
        .order("updated_at", { ascending: false }),
      supabase.from("profiles").select("*").eq("user_id", user.id).maybeSingle(),
    ]);
    if (trips.error || profile.error) {
      return { content: "Couldn't load the account just now. Please try again shortly.", isError: true };
    }

    const day = (iso: string) => iso.slice(0, 10);
    const preferences = describePreferences(profile.data as Profile | null);
    return {
      content: JSON.stringify(
        {
          trips: (trips.data ?? []).map((t) => ({ name: t.title, started: day(t.created_at), last_updated: day(t.updated_at) })),
          preferences: preferences.length ? preferences.map((line) => line.replace(/^- /, "")) : "none saved",
        },
        null,
        2,
      ),
      isError: false,
    };
  };
}

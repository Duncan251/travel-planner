import type Anthropic from "@anthropic-ai/sdk";
import { HANDOFF_MARKER, type Handoff } from "../handoff";

// The two handoff tools. Edit the descriptions to change when each assistant hands over.
// When either is called, the route stops the reply, shows the handoff message and opens
// the other assistant with the summary.

const MAX_SUMMARY = 300;

const summaryInput: Anthropic.Tool.InputSchema = {
  type: "object",
  properties: {
    summary: {
      type: "string",
      description:
        "One sentence, written about the traveller in the third person, saying what they need, with any details they've already given, e.g. \"They haven't received their sign-in email after two tries and want to know what to do.\"",
    },
  },
  required: ["summary"],
  additionalProperties: false,
};

// Katie's tool.
export const transferToSupportTool: Anthropic.Tool = {
  name: "transfer_to_support",
  description: `Pass the traveller to Amber, the support assistant, who handles questions about the Katie Travel service itself. Use it instead of answering when they ask about:
- their account, signing in, or sign-in emails
- privacy, their data, or deleting their account
- daily limits, or what the app can and can't do
- something not working (a bug, an error, a broken page or link)
- a complaint, or wanting to contact a person

Don't use it for anything about planning their trip, including questions about places, weather, bookings, prices or itineraries. Those are yours. If a message mixes both, answer the travel part and offer to pass them on for the rest.

After you call it, stop: the traveller sees a short handover message and Amber opens with your summary.`,
  input_schema: summaryInput,
};

// Amber's tool.
export const transferToPlannerTool: Anthropic.Tool = {
  name: "transfer_to_planner",
  description: `Pass the person to Katie, the trip planner, when they want help planning a trip or travel advice: where to go, what to see or eat, an itinerary or day plan, weather for a trip, or changes to a trip they're planning.

Don't use it for questions about using the app (signing in, preferences, saved trips, limits, privacy, problems). Those are yours, even when they mention a trip, for example "how do I rename my trip?".

After you call it, stop: they see a short handover message and Katie opens with your summary.`,
  input_schema: summaryInput,
};

// The summary from a handoff call, or null if it's missing or unusable.
export function handoffSummary(input: unknown): string | null {
  const summary = (input as { summary?: unknown } | null)?.summary;
  if (typeof summary !== "string" || !summary.trim()) return null;
  return summary.trim().replace(/\s+/g, " ").slice(0, MAX_SUMMARY);
}

export function logHandoff(from: string, to: string, summary: string, tripId: string | null) {
  console.log(`🔀 Handoff: ${from} → ${to}${tripId ? ` (trip ${tripId})` : ""}\n   Summary: ${summary}`);
}

// The hidden end-of-reply instruction telling the screen to open the other assistant.
export function handoffSignal(handoff: Handoff): string {
  return `\n${HANDOFF_MARKER}${JSON.stringify(handoff)}`;
}

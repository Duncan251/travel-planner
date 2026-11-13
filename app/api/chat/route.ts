import Anthropic from "@anthropic-ai/sdk";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { describePreferences, type Profile } from "@/lib/profile";
import type { TripRow } from "@/lib/supabase/database.types";
import { createClient, currentUser } from "@/lib/supabase/server";
import { runTool, tools } from "@/lib/tools";
import { saveTripProgressTool, tripProgressHandler } from "@/lib/tools/trip";
import { addUsage, emptyUsage, logUsage, toTotals } from "@/lib/usage";

// This file runs only on the server. The API key is read here and never sent to the browser.
export const runtime = "nodejs";

const MODEL = "claude-haiku-5-5";
const PROMPT_PATH = path.join(process.cwd(), "prompts", "planner.md");
// Safety limit: how many rounds of tool calls one reply may make before we stop it.
const MAX_TOOL_ROUNDS = 6;
// How many messages each signed-in user may send per day (days run midnight to midnight UTC).
const DAILY_MESSAGE_LIMIT = 50;
// How many earlier messages Katie sees; her saved summary covers anything older.
const RECENT_MESSAGES = 10;
const MAX_MESSAGE_LENGTH = 8000;
// After this long without a message, Katie opens with a short "welcome back" recap.
const RETURNING_AFTER_MS = 6 * 60 * 60 * 1000;
// Katie's tools, always in the same order: they're the start of every request, so keeping
// them identical lets the prompt cache match.
const KATIE_TOOLS: Anthropic.Tool[] = [...tools, saveTripProgressTool];
// Effort: "low" keeps early chat quick and cheap; "medium" makes Katie more thorough once
// itineraries are involved (the trip already has one, or the traveller is asking for one).
const ITINERARY_REQUEST = /\b(draft|itinerary|day[- ]by[- ]day|schedule|plan (out )?(the|our|my) days)\b/i;
// A reply with at least two "Day 1"-style lines is treated as an itinerary.
const ITINERARY_DAY_LINE = /^[\s>*_#-]*Day\s+\d+\b/gim;
const MAX_ITINERARY = 30000;

export async function POST(req: Request) {
  if (!process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_API_KEY.startsWith("your-")) {
    return new Response("ANTHROPIC_API_KEY is not set. Add your key to .env.local and restart the server.", {
      status: 500,
    });
  }

  // Only signed-in users can chat. This connection acts as them, so the database's
  // row-level security applies to everything below.
  const supabase = await createClient();
  const user = await currentUser(supabase);
  if (!user) return new Response("Please sign in to chat.", { status: 401 });

  const { tripId, message } = (await req.json().catch(() => ({}))) as { tripId?: unknown; message?: unknown };
  const text = typeof message === "string" ? message.trim() : "";
  if (!text) return new Response("The message was empty.", { status: 400 });
  if (text.length > MAX_MESSAGE_LENGTH) {
    return new Response(`That message is too long (max ${MAX_MESSAGE_LENGTH} characters).`, { status: 400 });
  }

  // Count this message against the user's daily limit (checked and counted in one step).
  const { data: usage, error: usageError } = await supabase
    .rpc("use_message", { daily_limit: DAILY_MESSAGE_LIMIT })
    .single();
  if (usageError) {
    console.error("Message limit check failed:", usageError.message);
    return new Response("Sorry, something went wrong on our side. Please try again shortly.", { status: 500 });
  }
  if (!usage.allowed) {
    return new Response(
      `You've reached today's limit of ${DAILY_MESSAGE_LIMIT} messages. It resets at midnight UTC.`,
      { status: 429 },
    );
  }

  // The trip being discussed, or a new one for the first message of a new trip.
  // Row-level security means a trip id belonging to someone else simply isn't found.
  let trip: TripRow;
  if (typeof tripId === "string" && tripId) {
    const { data } = await supabase.from("trips").select("*").eq("id", tripId).maybeSingle();
    if (!data) return new Response("That trip couldn't be found.", { status: 404 });
    trip = data;
  } else {
    const { data, error } = await supabase.from("trips").insert({}).select("*").single();
    if (error || !data) {
      console.error("Creating trip failed:", error?.message);
      return new Response("Sorry, we couldn't start a new trip. Please try again.", { status: 500 });
    }
    trip = data;
  }

  // The most recent earlier messages (one extra, to tell whether there are older ones).
  const { data: recentDesc } = await supabase
    .from("trip_messages")
    .select("role, content, created_at")
    .eq("trip_id", trip.id)
    .order("id", { ascending: false })
    .limit(RECENT_MESSAGES + 1);
  const hasOlder = (recentDesc?.length ?? 0) > RECENT_MESSAGES;
  const history = (recentDesc ?? []).slice(0, RECENT_MESSAGES).reverse();
  const lastMessageAt = history.at(-1)?.created_at ?? null;

  // Save the traveller's message, and move the trip to the top of their list.
  const { error: saveError } = await supabase
    .from("trip_messages")
    .insert({ trip_id: trip.id, role: "user", content: text });
  if (saveError) {
    console.error("Saving message failed:", saveError.message);
    return new Response("Sorry, we couldn't save your message. Please try again.", { status: 500 });
  }
  await touchTrip(supabase, trip.id);

  // Re-read on every request so edits to prompts/planner.md apply without a restart.
  // Then the user's saved preferences, this trip's notes, and today's date last so Katie
  // can work out "next weekend" and the forecast window.
  const persona = (await readFile(PROMPT_PATH, "utf8")).trim();
  const { data: profile } = await supabase.from("profiles").select("*").eq("user_id", user.id).maybeSingle();
  const today = new Date().toLocaleDateString("en-GB", { weekday: "long", year: "numeric", month: "long", day: "numeric" });
  //
  // Prompt caching: the tool definitions and the persona are the same on every request, so
  // the persona block carries a cache marker. Everything that varies by traveller, trip or
  // day goes in the second block, after the marker, so it can't stop the cache matching.
  const system: Anthropic.TextBlockParam[] = [
    { type: "text", text: persona, cache_control: { type: "ephemeral" } },
    {
      type: "text",
      text: [
        preferencesSection(profile as Profile | null),
        tripSection(trip, hasOlder, lastMessageAt),
        `Today's date is ${today}.`,
      ].join("\n\n"),
    },
  ];

  const client = new Anthropic(); // picks up ANTHROPIC_API_KEY from the environment
  const conversation = toConversation([...history, { role: "user", content: text }]);
  const tripTools = { [saveTripProgressTool.name]: tripProgressHandler(supabase, trip.id) };
  const effort = trip.itinerary || ITINERARY_REQUEST.test(text) ? "medium" : "low";
  let current: { abort(): void } | undefined; // the in-flight request, so it can be cancelled

  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    async start(controller) {
      let reply = ""; // Katie's words, saved to the trip afterwards
      const send = (chunk: string) => controller.enqueue(encoder.encode(chunk));
      const say = (chunk: string) => {
        reply += chunk;
        send(chunk);
      };
      let needsGap = false;
      let totals = emptyUsage();
      let rounds = 0;
      let finished = false; // the reply ended normally (not cut off or interrupted)
      let itinerarySaved = false; // Katie saved an itinerary herself in this reply

      try {
        // The tool loop: stream Claude's reply; if it asks for tools, run them,
        // send the results back, and let it continue, until it finishes.
        for (let round = 0; ; round++) {
          const stream = client.messages.stream({
            model: MODEL,
            max_tokens: 16000,
            output_config: { effort },
            // Automatic caching of the whole request so far: when Katie uses tools, the next
            // round re-sends all of this seconds later and reads it from the cache.
            cache_control: { type: "ephemeral" },
            system,
            tools: KATIE_TOOLS,
            messages: conversation,
          });
          current = stream;

          for await (const event of stream) {
            if (event.type === "content_block_delta" && event.delta.type === "text_delta") {
              if (needsGap) {
                say("\n\n");
                needsGap = false;
              }
              say(event.delta.text);
            }
          }

          const message: Anthropic.Message = await stream.finalMessage();
          const usage = toTotals(message.usage);
          totals = addUsage(totals, usage);
          rounds++;
          logUsage(`🧭 Katie round ${rounds} (${effort} effort)`, usage);
          if (message.stop_reason === "refusal") {
            send("\n\n(Claude declined to answer this request.)");
            break;
          }

          const toolCalls = message.content.filter((b): b is Anthropic.ToolUseBlock => b.type === "tool_use");
          if (message.stop_reason !== "tool_use" || toolCalls.length === 0) {
            finished = message.stop_reason === "end_turn";
            break;
          }

          if (round >= MAX_TOOL_ROUNDS) {
            send("\n\n(Stopped: too many lookups in one reply. Try asking again more specifically.)");
            break;
          }

          // Run every tool Claude asked for at once, then return all the results in one message.
          conversation.push({ role: "assistant", content: message.content });
          const results = await Promise.all(
            toolCalls.map(async (call): Promise<Anthropic.ToolResultBlockParam> => {
              const output = await runTool(call.name, call.input, tripTools);
              const savedItinerary = (call.input as { itinerary?: unknown } | null)?.itinerary;
              if (call.name === saveTripProgressTool.name && !output.isError && typeof savedItinerary === "string" && savedItinerary.trim()) {
                itinerarySaved = true;
              }
              return { type: "tool_result", tool_use_id: call.id, content: output.content, is_error: output.isError };
            }),
          );
          conversation.push({ role: "user", content: results });

          // Separate any text written before the tool call from what comes after it.
          if (message.content.some((b) => b.type === "text" && b.text.trim())) needsGap = true;
        }
      } catch (err) {
        const message = err instanceof Anthropic.APIError ? err.message : "Unexpected error talking to Claude.";
        console.error("Chat route error:", err);
        send(`\n\n⚠️ ${message}`);
      } finally {
        if (rounds > 0) logUsage(`🧭 Katie reply total (${rounds} round${rounds === 1 ? "" : "s"}, ${effort} effort)`, totals);
        // Guarantee: if Katie shared an itinerary but didn't save it herself, save her reply as
        // the trip's itinerary, exactly as the traveller saw it. Never for an interrupted reply.
        if (finished && !itinerarySaved && looksLikeItinerary(reply)) {
          const { error } = await supabase
            .from("trips")
            .update({ itinerary: reply.trim().slice(0, MAX_ITINERARY), updated_at: new Date().toISOString() })
            .eq("id", trip.id);
          console.log(error ? `📌 Saving the itinerary failed: ${error.message}` : "📌 Itinerary saved automatically (Katie didn't save it herself)");
        }
        // Save Katie's reply (even a partial one) so the trip shows it next time.
        if (reply.trim()) {
          const { error } = await supabase
            .from("trip_messages")
            .insert({ trip_id: trip.id, role: "assistant", content: reply });
          if (error) console.error("Saving Katie's reply failed:", error.message);
          await touchTrip(supabase, trip.id);
        }
        controller.close();
      }
    },
    cancel() {
      current?.abort();
    },
  });

  return new Response(body, {
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "Cache-Control": "no-cache",
      "X-Trip-Id": trip.id, // lets the page switch its address to this trip
    },
  });
}

function looksLikeItinerary(text: string): boolean {
  return (text.match(ITINERARY_DAY_LINE) ?? []).length >= 2;
}

async function touchTrip(supabase: Awaited<ReturnType<typeof createClient>>, tripId: string) {
  await supabase.from("trips").update({ updated_at: new Date().toISOString() }).eq("id", tripId);
}

// Turns saved messages into the shape Claude expects: starting with the traveller, and
// never two messages in a row from the same side (merged if, say, a reply failed to save).
function toConversation(messages: { role: "user" | "assistant"; content: string }[]): Anthropic.MessageParam[] {
  const result: { role: "user" | "assistant"; content: string }[] = [];
  for (const m of messages) {
    if (result.length === 0 && m.role === "assistant") continue;
    const last = result.at(-1);
    if (last && last.role === m.role) last.content += `\n\n${m.content}`;
    else result.push({ role: m.role, content: m.content });
  }
  return result;
}

// The user's saved preferences for the system prompt, with how Katie should use them.
function preferencesSection(profile: Profile | null): string {
  const lines = describePreferences(profile);
  if (lines.length === 0) {
    return "# This traveller's saved preferences\n\nThey haven't saved any preferences yet, so ask about their travel style as usual. They can add preferences any time from the Preferences link.";
  }
  return [
    "# This traveller's saved preferences",
    "",
    "They saved these in their profile, in their own words:",
    "",
    ...lines,
    "",
    "Treat these as already known. Don't ask for them again. When one matters for this trip, confirm it briefly in passing (for example \"Still happy with self-guided?\") and adjust if they say it's changed. Don't read the whole list back to them. Anything they say in this conversation takes priority over the saved preferences.",
  ].join("\n");
}

// This trip's saved notes for the system prompt, so Katie picks up where she left off.
function tripSection(trip: TripRow, hasOlder: boolean, lastMessageAt: string | null): string {
  if (!trip.summary && !trip.itinerary && !lastMessageAt) {
    return [
      "# This trip",
      "",
      "This is a new trip. It's saved automatically as you talk. Use save_trip_progress to keep your notes up to date, and to suggest a name once you know the destination and rough dates.",
    ].join("\n");
  }

  const parts = [
    "# This trip",
    "",
    `This conversation is saved as a trip called "${trip.title}"${trip.title_set_by_user ? " (the traveller chose this name)" : ""}.`,
  ];
  if (trip.summary) {
    parts.push("", "## Your notes so far", "", trip.summary);
  }
  if (trip.itinerary) {
    parts.push(
      "",
      "## Itinerary you've already shared",
      "",
      "This is the latest itinerary you shared, exactly as the traveller saw it. Whenever you show it again, reproduce it word for word, changing only what you've agreed to change, and say what changed.",
      "",
      "---",
      trip.itinerary,
      "---",
    );
  }
  if (hasOlder) {
    parts.push(
      "",
      "Only the most recent messages of this conversation are included below; your notes cover everything earlier.",
    );
  }
  parts.push("", "Don't ask again about anything your notes say is already answered or decided.");
  if (lastMessageAt && Date.now() - Date.parse(lastMessageAt) > RETURNING_AFTER_MS) {
    const when = new Date(lastMessageAt).toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric" });
    parts.push(
      "",
      `The traveller is coming back to this trip after a break (the last message was on ${when}). Start with a short, friendly recap of where you left off, then carry on.`,
    );
  }
  parts.push("", "Keep your notes current with save_trip_progress whenever something new is decided or you share an itinerary.");
  return parts.join("\n");
}

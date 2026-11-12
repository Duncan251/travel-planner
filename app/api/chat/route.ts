import Anthropic from "@anthropic-ai/sdk";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { describePreferences, type Profile } from "@/lib/profile";
import { createClient, currentUser } from "@/lib/supabase/server";
import { runTool, tools } from "@/lib/tools";

// This file runs only on the server. The API key is read here and never sent to the browser.
export const runtime = "nodejs";

const MODEL = "claude-haiku-5-5";
const PROMPT_PATH = path.join(process.cwd(), "prompts", "planner.md");
// Safety limit: how many rounds of tool calls one reply may make before we stop it.
const MAX_TOOL_ROUNDS = 6;
// How many messages each signed-in user may send per day (days run midnight to midnight UTC).
const DAILY_MESSAGE_LIMIT = 50;

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

  const { messages } = (await req.json()) as { messages: Anthropic.MessageParam[] };

  // Re-read on every request so edits to prompts/planner.md apply without a restart.
  // Then the user's saved preferences, and today's date last so Katie can work out
  // "next weekend" and the forecast window.
  const persona = (await readFile(PROMPT_PATH, "utf8")).trim();
  const { data: profile } = await supabase.from("profiles").select("*").eq("user_id", user.id).maybeSingle();
  const today = new Date().toLocaleDateString("en-GB", { weekday: "long", year: "numeric", month: "long", day: "numeric" });
  const system = [persona, preferencesSection(profile as Profile | null), `Today's date is ${today}.`]
    .filter(Boolean)
    .join("\n\n");

  const client = new Anthropic(); // picks up ANTHROPIC_API_KEY from the environment
  const conversation: Anthropic.MessageParam[] = [...messages];
  let current: { abort(): void } | undefined; // the in-flight request, so it can be cancelled

  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (text: string) => controller.enqueue(encoder.encode(text));
      let needsGap = false;

      try {
        // The tool loop: stream Claude's reply; if it asks for tools, run them,
        // send the results back, and let it continue, until it finishes.
        for (let round = 0; ; round++) {
          const stream = client.messages.stream({
            model: MODEL,
            max_tokens: 16000,
            output_config: { effort: "low" }, // quick, conversational replies
            system,
            tools,
            messages: conversation,
          });
          current = stream;

          for await (const event of stream) {
            if (event.type === "content_block_delta" && event.delta.type === "text_delta") {
              if (needsGap) {
                send("\n\n");
                needsGap = false;
              }
              send(event.delta.text);
            }
          }

          const message: Anthropic.Message = await stream.finalMessage();
          if (message.stop_reason === "refusal") {
            send("\n\n(Claude declined to answer this request.)");
            break;
          }

          const toolCalls = message.content.filter((b): b is Anthropic.ToolUseBlock => b.type === "tool_use");
          if (message.stop_reason !== "tool_use" || toolCalls.length === 0) break;

          if (round >= MAX_TOOL_ROUNDS) {
            send("\n\n(Stopped: too many lookups in one reply. Try asking again more specifically.)");
            break;
          }

          // Run every tool Claude asked for at once, then return all the results in one message.
          conversation.push({ role: "assistant", content: message.content });
          const results = await Promise.all(
            toolCalls.map(async (call): Promise<Anthropic.ToolResultBlockParam> => {
              const output = await runTool(call.name, call.input);
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
        controller.close();
      }
    },
    cancel() {
      current?.abort();
    },
  });

  return new Response(body, {
    headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-cache" },
  });
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

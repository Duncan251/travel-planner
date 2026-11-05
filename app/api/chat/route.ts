import Anthropic from "@anthropic-ai/sdk";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { runTool, tools } from "@/lib/tools";

// This file runs only on the server. The API key is read here and never sent to the browser.
export const runtime = "nodejs";

const MODEL = "claude-haiku-5-5";
const PROMPT_PATH = path.join(process.cwd(), "prompts", "planner.md");
// Safety limit: how many rounds of tool calls one reply may make before we stop it.
const MAX_TOOL_ROUNDS = 6;

export async function POST(req: Request) {
  if (!process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_API_KEY.startsWith("your-")) {
    return new Response("ANTHROPIC_API_KEY is not set. Add your key to .env.local and restart the server.", {
      status: 500,
    });
  }

  const { messages } = (await req.json()) as { messages: Anthropic.MessageParam[] };

  // Re-read on every request so edits to prompts/planner.md apply without a restart.
  // Today's date goes last so Katie can work out "next weekend" and the forecast window.
  const persona = (await readFile(PROMPT_PATH, "utf8")).trim();
  const today = new Date().toLocaleDateString("en-GB", { weekday: "long", year: "numeric", month: "long", day: "numeric" });
  const system = `${persona}\n\nToday's date is ${today}.`;

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

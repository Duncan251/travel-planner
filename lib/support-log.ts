import "server-only"; // writes support logs with the administrator key
import Anthropic from "@anthropic-ai/sdk";
import { CONVERSATION_MARKER, END_MARKER, type ConversationEnd } from "./handoff";
import { isValidSignature, signValue } from "./signing";
import { createAdminClient } from "./supabase/admin";
import { SUPPORT_TOPICS, type SupportOutcome, type SupportTopic } from "./supabase/database.types";
import { logUsage, toTotals } from "./usage";

// Saves every conversation with Amber to support_conversations: its messages, how it ended
// (resolved, handed to Katie, escalated or abandoned), its topic, and any "Did this help?" rating.

const PASS_PURPOSE = "support-conversation";
const ABANDON_AFTER_MS = 30 * 60_000; // no message for 30 minutes
const MAX_SAVED_MESSAGES = 60;
const MODEL = "claude-haiku-5-5";

type Message = { role: string; content: string };

// ---- The signed pass the Help panel holds for its current conversation ----

function passFor(id: string): string {
  return `${id}.${signValue(PASS_PURPOSE, id)}`;
}

function idFromPass(pass: unknown): string | null {
  if (typeof pass !== "string") return null;
  const [id, signature] = pass.split(".");
  return id && signature && isValidSignature(PASS_PURPOSE, id, signature) ? id : null;
}

export function conversationPassMarker(pass: string): string {
  return `\n${CONVERSATION_MARKER}${JSON.stringify({ token: pass })}`;
}

export function conversationEndMarker(end: ConversationEnd): string {
  return `\n${END_MARKER}${JSON.stringify(end)}`;
}

// ---- Starting, saving and ending ----

// Continues the panel's conversation if its pass is genuine and the conversation is still
// open; otherwise starts a new one. Returns null if logging isn't available.
export async function openConversation(pass: unknown, userId: string | null) {
  const admin = createAdminClient();
  if (!admin) return null;

  const existingId = idFromPass(pass);
  if (existingId) {
    const { data } = await admin.from("support_conversations").select("id, outcome").eq("id", existingId).maybeSingle();
    if (data && !data.outcome) return { id: data.id, pass: pass as string, isNew: false };
  }

  const { data, error } = await admin.from("support_conversations").insert({ user_id: userId }).select("id").single();
  if (error || !data) {
    console.error("Starting a support log failed:", error?.message);
    return null;
  }
  return { id: data.id, pass: passFor(data.id), isNew: true };
}

export async function saveMessages(id: string, messages: Message[]) {
  const admin = createAdminClient();
  if (!admin) return;
  const { error } = await admin
    .from("support_conversations")
    .update({ messages: messages.slice(-MAX_SAVED_MESSAGES), last_message_at: new Date().toISOString() })
    .eq("id", id);
  if (error) console.error("Saving a support log failed:", error.message);
}

// Notes the ticket an escalation created. The conversation stays open, so follow-up details
// added to the ticket are logged with it; however it ends, its outcome will be "escalated".
export async function recordTicket(id: string, ticketNumber: number) {
  const admin = createAdminClient();
  if (!admin) return;
  await admin.from("support_conversations").update({ ticket_number: ticketNumber }).eq("id", id);
}

// Records how the conversation ended, with its final messages (only once). A conversation that
// raised a ticket always counts as "escalated". Returns the outcome saved, or null if it had
// already ended. Quick, so it runs before the reply finishes; the topic is worked out after.
export async function endConversation(id: string, outcome: SupportOutcome, messages: Message[]): Promise<SupportOutcome | null> {
  const admin = createAdminClient();
  if (!admin) return null;
  const { data: current } = await admin.from("support_conversations").select("ticket_number").eq("id", id).maybeSingle();
  const finalOutcome: SupportOutcome = current?.ticket_number ? "escalated" : outcome;
  const { data } = await admin
    .from("support_conversations")
    .update({
      outcome: finalOutcome,
      ended_at: new Date().toISOString(),
      messages: messages.slice(-MAX_SAVED_MESSAGES),
      last_message_at: new Date().toISOString(),
    })
    .eq("id", id)
    .is("outcome", null)
    .select("id")
    .maybeSingle();
  return data ? finalOutcome : null;
}

// Closes conversations with no message for 30 minutes as "abandoned". Their end time is
// 30 minutes after the last message, however late this runs.
export async function closeAbandonedConversations(limit = 20): Promise<number> {
  const admin = createAdminClient();
  if (!admin) return 0;
  const cutoff = new Date(Date.now() - ABANDON_AFTER_MS).toISOString();
  const { data: stale } = await admin
    .from("support_conversations")
    .select("id, last_message_at, messages, ticket_number")
    .is("outcome", null)
    .lt("last_message_at", cutoff)
    .order("last_message_at", { ascending: true })
    .limit(limit);

  let closed = 0;
  for (const conversation of stale ?? []) {
    const endedAt = new Date(Date.parse(conversation.last_message_at) + ABANDON_AFTER_MS).toISOString();
    const outcome: SupportOutcome = conversation.ticket_number ? "escalated" : "abandoned";
    const { data } = await admin
      .from("support_conversations")
      .update({ outcome, ended_at: endedAt })
      .eq("id", conversation.id)
      .is("outcome", null)
      .select("id")
      .maybeSingle();
    if (data) {
      closed++;
      await setTopic(conversation.id, conversation.messages, outcome);
    }
  }
  return closed;
}

// Saves a "Did this help?" answer: only for a genuine pass, once, and only after the
// conversation has ended or raised a ticket (the moments the question is shown).
export async function rateConversation(pass: unknown, rating: unknown): Promise<boolean> {
  const id = idFromPass(pass);
  const admin = createAdminClient();
  if (!id || !admin || (rating !== "up" && rating !== "down")) return false;
  const { data } = await admin
    .from("support_conversations")
    .update({ rating, rated_at: new Date().toISOString() })
    .eq("id", id)
    .or("outcome.not.is.null,ticket_number.not.is.null")
    .is("rating", null)
    .select("id")
    .maybeSingle();
  if (data) console.log(`👍 Support rating: ${rating === "up" ? "helpful" : "not helpful"} (conversation ${id})`);
  return Boolean(data);
}

// ---- Topic ----

const TOPIC_GUIDE = `Read a conversation between a person and Amber, the support assistant for Katie Travel (an AI trip-planning app), and choose the one topic that best describes what the person needed. If it covers several, choose the main one.

- sign-in: signing in, magic links, sign-in emails not arriving
- account: their account, email address or saved travel preferences
- trips: finding, reopening, renaming, deleting or missing saved trips; or wanting trip planning
- privacy: what data is stored, who can see it, deleting their account and data
- limits: daily message or search limits, whether it's free, costs
- accuracy: wrong or out-of-date information, such as a closed place, wrong hours, broken links or weather
- bug: something in the app not working, errors, pages not loading
- feedback: suggestions, complaints or praise about the service
- other: anything else, or no clear request`;

export async function setTopic(id: string, messages: Message[], outcome: SupportOutcome) {
  const topic = await classifyTopic(messages);
  const admin = createAdminClient();
  if (!admin) return;
  await admin.from("support_conversations").update({ topic }).eq("id", id);
  console.log(`🗂️ Support conversation ended: ${outcome} · topic: ${topic} (${messages.length} messages)`);
}

async function classifyTopic(messages: Message[]): Promise<SupportTopic> {
  if (!messages.length || !process.env.ANTHROPIC_API_KEY) return "other";
  const transcript = messages.map((m) => `${m.role === "user" ? "Person" : "Amber"}: ${m.content}`).join("\n\n").slice(0, 20_000);
  try {
    const response = await new Anthropic().messages.create({
      model: MODEL,
      max_tokens: 1000,
      system: TOPIC_GUIDE,
      // Structured output: the reply must be {"topic": <one of the nine>}.
      output_config: {
        effort: "low",
        format: {
          type: "json_schema",
          schema: {
            type: "object",
            properties: { topic: { type: "string", enum: [...SUPPORT_TOPICS] } },
            required: ["topic"],
            additionalProperties: false,
          },
        },
      },
      messages: [{ role: "user", content: `<conversation>\n${transcript}\n</conversation>` }],
    });
    logUsage("🏷️ Support topic", toTotals(response.usage));
    const text = response.content.find((b) => b.type === "text")?.text ?? "";
    const topic = (JSON.parse(text) as { topic?: string }).topic;
    return SUPPORT_TOPICS.includes(topic as SupportTopic) ? (topic as SupportTopic) : "other";
  } catch (err) {
    console.error("Classifying a support topic failed:", err instanceof Error ? err.message : err);
    return "other";
  }
}

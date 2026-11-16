import "server-only"; // signs receipts with a server secret and reads tickets as administrator
import { createHmac, timingSafeEqual } from "node:crypto";
import { RECEIPT_MARKER, type TicketReceipt } from "./handoff";
import { createAdminClient } from "./supabase/admin";

// Ticket continuity for Amber. The Help panel only keeps the text of her replies, not her
// tool use, so on each message the server tells her which tickets already exist:
// - tickets created in this conversation, proven by signed receipts the panel sends back
//   (a receipt can only be made by the server, so it can't be faked or guessed), and
// - for a signed-in person, their own tickets from the last day.

const RECENT_HOURS = 24;

function secret(): string {
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!key) throw new Error("SUPABASE_SERVICE_ROLE_KEY is not set");
  return `ticket-receipts:${key}`;
}

function sign(ticket: number): string {
  return createHmac("sha256", secret()).update(`ticket:${ticket}`).digest("hex").slice(0, 32);
}

// The hidden marker the server adds to a reply when it creates a ticket.
export function receiptMarker(ticket: number): string {
  const receipt: TicketReceipt = { ticket, sig: sign(ticket) };
  return `\n${RECEIPT_MARKER}${JSON.stringify(receipt)}`;
}

// Ticket numbers from receipts the panel sent back, keeping only genuine ones.
export function verifiedReceiptTickets(receipts: unknown): number[] {
  if (!Array.isArray(receipts)) return [];
  const tickets = new Set<number>();
  for (const r of receipts.slice(0, 20) as Partial<TicketReceipt>[]) {
    if (typeof r?.ticket !== "number" || typeof r.sig !== "string") continue;
    const expected = Buffer.from(sign(r.ticket));
    const given = Buffer.from(r.sig);
    if (expected.length === given.length && timingSafeEqual(expected, given)) tickets.add(r.ticket);
  }
  return [...tickets];
}

export type KnownTicket = { number: number; title: string; createdAt: string; updates: number; fromThisChat: boolean };

// The tickets Amber should know about: this conversation's, plus a signed-in person's recent ones.
export async function knownTickets(receiptTickets: number[], userId: string | null): Promise<KnownTicket[]> {
  const admin = createAdminClient();
  if (!admin || (receiptTickets.length === 0 && !userId)) return [];

  const since = new Date(Date.now() - RECENT_HOURS * 3600_000).toISOString();
  const query = admin.from("tickets").select("ticket_number, title, created_at, updates, user_id");
  const { data } = userId
    ? await query.or(
        `and(user_id.eq.${userId},created_at.gte.${since})${receiptTickets.length ? `,ticket_number.in.(${receiptTickets.join(",")})` : ""}`,
      )
    : await query.in("ticket_number", receiptTickets);

  return (data ?? [])
    .sort((a, b) => a.ticket_number - b.ticket_number)
    .map((t) => ({
      number: t.ticket_number,
      title: t.title,
      createdAt: t.created_at,
      updates: Array.isArray(t.updates) ? t.updates.length : 0,
      fromThisChat: receiptTickets.includes(t.ticket_number),
    }));
}

// The note added to Amber's instructions (after the cached part) on every message.
export function ticketsNote(tickets: KnownTicket[]): string {
  const lines = tickets.map(
    (t) =>
      `- KT-${t.number}: "${t.title}" (created ${t.createdAt.slice(0, 16).replace("T", " ")} UTC${t.updates ? `, ${t.updates} update${t.updates === 1 ? "" : "s"}` : ""}${t.fromThisChat ? ", in this conversation" : ""})`,
  );
  return [
    "# Tickets already raised",
    "",
    "Your earlier tool use isn't shown in the conversation, so this list, taken from the database, is the record. These tickets all exist; never tell the person otherwise.",
    "",
    ...(lines.length ? lines : ["- None yet."]),
    "",
    "If the person adds details about a problem that already has a ticket, use add_to_ticket with that number instead of escalating again.",
  ].join("\n");
}

// Shared settings for handoffs between Katie (the trip planner) and Amber (the support assistant).
// Used by both the server routes and the chat screens, so keep this file free of
// server-only code.

export const PLANNER_NAME = "Katie";
export const SUPPORT_NAME = "Amber"; // the support assistant (opened from the Help button)

// What the traveller sees when they're passed across.
export const TO_SUPPORT_MESSAGE = `I'll pass you to ${SUPPORT_NAME}, who handles account questions.`;
export const TO_PLANNER_MESSAGE = `I'll pass you to ${PLANNER_NAME}, our trip planner, who can help with that.`;

// The first message the receiving assistant gets: this label, then the one-sentence summary.
// The chat screens show it as a small note rather than as something the traveller typed.
export const FROM_PLANNER_LABEL = `[Passed from ${PLANNER_NAME}] `;
export const FROM_SUPPORT_LABEL = `[Passed from ${SUPPORT_NAME}] `;
// The label used before the support assistant was named, so older saved notes still show as notes.
const OLD_FROM_SUPPORT_LABEL = "[Passed from the Help assistant] ";

// The server can end a reply with hidden markers, each starting with this character and
// followed by a word and a little JSON. They're never shown:
//   HANDOFF - open the other assistant;  RECEIPT - a signed receipt for a new support ticket.
const MARKER_START = "\u001e";
export const HANDOFF_MARKER = `${MARKER_START}HANDOFF `;
export const RECEIPT_MARKER = `${MARKER_START}RECEIPT `;

export type Handoff = { to: "support" | "planner"; summary: string };
export type TicketReceipt = { ticket: number; sig: string };

// The JSON after each marker of one kind (markers come at the end of a reply, in any order).
function readMarkers<T>(text: string, marker: string): T[] {
  return text
    .split(MARKER_START)
    .slice(1)
    .filter((part) => `${MARKER_START}${part}`.startsWith(marker))
    .flatMap((part) => {
      try {
        return [JSON.parse(part.slice(marker.length - MARKER_START.length)) as T];
      } catch {
        return []; // still arriving
      }
    });
}

// Splits streamed text into what to show and any handoff instruction at the end.
export function splitHandoff(text: string): { visible: string; handoff: Handoff | null } {
  return { visible: text.split(MARKER_START)[0], handoff: readMarkers<Handoff>(text, HANDOFF_MARKER)[0] ?? null };
}

// Ticket receipts in a support reply, for the Help panel to send back with later messages.
export function readReceipts(text: string): TicketReceipt[] {
  return readMarkers<TicketReceipt>(text, RECEIPT_MARKER);
}

// If a message is a handoff note, returns who it came from and the summary.
export function readHandoffNote(content: string): { from: string; summary: string } | null {
  if (content.startsWith(FROM_PLANNER_LABEL)) return { from: PLANNER_NAME, summary: content.slice(FROM_PLANNER_LABEL.length) };
  if (content.startsWith(FROM_SUPPORT_LABEL)) return { from: SUPPORT_NAME, summary: content.slice(FROM_SUPPORT_LABEL.length) };
  if (content.startsWith(OLD_FROM_SUPPORT_LABEL)) return { from: SUPPORT_NAME, summary: content.slice(OLD_FROM_SUPPORT_LABEL.length) };
  return null;
}

// Hands a summary from the Help panel to Katie's chat across a page change.
export const PENDING_PLANNER_HANDOFF_KEY = "katie-pending-handoff";

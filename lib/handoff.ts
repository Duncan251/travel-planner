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

// The server ends a reply that hands off with this marker and a little JSON, so the
// screen knows to open the other assistant. It's never shown.
export const HANDOFF_MARKER = "\u001eHANDOFF ";

export type Handoff = { to: "support" | "planner"; summary: string };

// Splits streamed text into what to show and any handoff instruction at the end.
export function splitHandoff(text: string): { visible: string; handoff: Handoff | null } {
  const at = text.indexOf(HANDOFF_MARKER);
  if (at === -1) return { visible: text.split("\u001e")[0], handoff: null };
  try {
    return { visible: text.slice(0, at), handoff: JSON.parse(text.slice(at + HANDOFF_MARKER.length)) as Handoff };
  } catch {
    return { visible: text.slice(0, at), handoff: null }; // marker still arriving
  }
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

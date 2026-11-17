import type Anthropic from "@anthropic-ai/sdk";

// Amber's mark_resolved tool. It records nothing itself: the support route sees the call,
// logs the conversation as resolved, and shows "Did this help?".

export const markResolvedTool: Anthropic.Tool = {
  name: "mark_resolved",
  description: `Mark this support conversation as resolved. Call it only when the person confirms their question is answered or their problem is sorted, for example "thanks, that worked" or "great, that's all I needed". Don't call it just because you've given an answer, if they still seem stuck, or after passing them to Katie.

Write your short closing reply first, then call it. The app then asks them whether this helped.`,
  input_schema: { type: "object", properties: {}, additionalProperties: false },
};

export async function markResolved() {
  return { content: "Marked as resolved. Nothing more to add.", isError: false };
}

import type Anthropic from "@anthropic-ai/sdk";

// Token usage and an estimated cost for Claude replies, printed to the terminal so you can
// see what each reply costs and how much came from the prompt cache.

// Claude Haiku 5.5 prices in US$ per million tokens, for prompts up to 100K tokens.
// Check https://www.anthropic.com/pricing if the model or prices change.
const PRICE = { input: 0.1, cacheWrite: 0.125, cacheRead: 0.01, output: 0.5 };

export type UsageTotals = { input: number; cacheWrite: number; cacheRead: number; output: number };

export function emptyUsage(): UsageTotals {
  return { input: 0, cacheWrite: 0, cacheRead: 0, output: 0 };
}

export function toTotals(u: Anthropic.Usage): UsageTotals {
  return {
    input: u.input_tokens,
    cacheWrite: u.cache_creation_input_tokens ?? 0,
    cacheRead: u.cache_read_input_tokens ?? 0,
    output: u.output_tokens,
  };
}

export function addUsage(a: UsageTotals, b: UsageTotals): UsageTotals {
  return {
    input: a.input + b.input,
    cacheWrite: a.cacheWrite + b.cacheWrite,
    cacheRead: a.cacheRead + b.cacheRead,
    output: a.output + b.output,
  };
}

export function estimateCost(u: UsageTotals): number {
  return (
    (u.input * PRICE.input + u.cacheWrite * PRICE.cacheWrite + u.cacheRead * PRICE.cacheRead + u.output * PRICE.output) /
    1_000_000
  );
}

export function logUsage(label: string, u: UsageTotals) {
  console.log(
    `${label}  input: ${u.input} new + ${u.cacheRead} read from cache + ${u.cacheWrite} written to cache · output: ${u.output} · ≈ $${estimateCost(u).toFixed(5)}`,
  );
}

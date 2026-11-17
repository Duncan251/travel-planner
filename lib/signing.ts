import "server-only"; // uses a server secret
import { createHmac, timingSafeEqual } from "node:crypto";

// Tamper-proof signatures for values the server hands to the browser and gets back later
// (ticket receipts, support conversation passes). Only the server can make a valid one.

function secret(purpose: string): string {
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!key) throw new Error("SUPABASE_SERVICE_ROLE_KEY is not set");
  return `${purpose}:${key}`;
}

export function signValue(purpose: string, value: string): string {
  return createHmac("sha256", secret(purpose)).update(value).digest("hex").slice(0, 32);
}

export function isValidSignature(purpose: string, value: string, signature: string): boolean {
  const expected = Buffer.from(signValue(purpose, value));
  const given = Buffer.from(signature);
  return expected.length === given.length && timingSafeEqual(expected, given);
}

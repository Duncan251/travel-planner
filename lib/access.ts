import { createHmac, timingSafeEqual } from "node:crypto";

// Shared by proxy.ts (which checks the pass) and app/api/access (which hands it out).

export const ACCESS_COOKIE = "tp_access";
export const ACCESS_MAX_AGE = 60 * 60 * 24 * 30; // 30 days, in seconds

// The access code from ACCESS_CODE, upper-cased so typing it is case-insensitive, or null when unset.
export function accessCode(): string | null {
  const code = process.env.ACCESS_CODE?.trim().toUpperCase();
  return code ? code : null;
}

// The cookie value that proves someone entered the right code. It's derived from the code,
// so changing ACCESS_CODE makes every existing pass invalid.
export function accessToken(code: string): string {
  return createHmac("sha256", code).update("travel-planner-access").digest("hex");
}

// Compares two strings in constant time, so response timing doesn't hint at how close a guess was.
export function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

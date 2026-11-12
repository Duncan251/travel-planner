import { NextResponse } from "next/server";
import { ACCESS_COOKIE, ACCESS_MAX_AGE, accessCode, accessToken, safeEqual } from "@/lib/access";

export const runtime = "nodejs";

const WRONG_CODE_DELAY_MS = 1000; // slows down anyone trying codes one after another

// Checks the code typed on the access page and, if it's right, gives the browser a 30-day pass.
export async function POST(req: Request) {
  const code = accessCode();
  if (!code) {
    return NextResponse.json({ error: "The access code isn't set up on the server yet." }, { status: 503 });
  }

  const { code: entered } = (await req.json().catch(() => ({}))) as { code?: unknown };
  if (typeof entered !== "string" || !safeEqual(entered.trim().toUpperCase(), code)) {
    await new Promise((resolve) => setTimeout(resolve, WRONG_CODE_DELAY_MS));
    return NextResponse.json({ error: "That code isn't right. Please try again." }, { status: 401 });
  }

  const res = NextResponse.json({ ok: true });
  res.cookies.set(ACCESS_COOKIE, accessToken(code), {
    httpOnly: true, // page scripts can't read it
    secure: process.env.NODE_ENV === "production", // HTTPS only on the live site
    sameSite: "lax",
    path: "/",
    maxAge: ACCESS_MAX_AGE,
  });
  return res;
}

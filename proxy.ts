import { NextResponse, type NextRequest } from "next/server";
import { ACCESS_COOKIE, accessCode, accessToken, safeEqual } from "@/lib/access";
import { refreshSession } from "@/lib/supabase/proxy";

// Runs before every request (except those excluded in `config` below). First it turns
// away anyone without a valid access pass, then it keeps the sign-in session fresh.
export async function proxy(request: NextRequest) {
  const code = accessCode();
  if (!code) {
    // No code set: open while developing locally, but locked on the live site,
    // so a forgotten setting never leaves it open.
    if (process.env.NODE_ENV === "production") return deny(request);
  } else {
    const pass = request.cookies.get(ACCESS_COOKIE)?.value;
    if (!pass || !safeEqual(pass, accessToken(code))) return deny(request);
  }
  return refreshSession(request);
}

function deny(request: NextRequest) {
  // The chat API gets a plain refusal; pages are sent to the access page.
  if (request.nextUrl.pathname.startsWith("/api/")) {
    return new NextResponse("Access code required.", { status: 401 });
  }
  const url = request.nextUrl.clone();
  url.pathname = "/access";
  url.search = "";
  return NextResponse.redirect(url);
}

export const config = {
  // Everything except the access page, the code check, sign-in links from emails
  // (which may be opened on a device that hasn't entered the code), and Next.js's own files.
  matcher: ["/((?!access$|api/access$|auth/confirm$|_next/static|_next/image|favicon.ico).*)"],
};

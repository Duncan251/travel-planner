import { NextResponse, type NextRequest } from "next/server";
import { ACCESS_COOKIE, accessCode, accessToken, safeEqual } from "@/lib/access";

// Runs before every request (except those excluded in `config` below) and turns away
// anyone without a valid access pass.
export function proxy(request: NextRequest) {
  const code = accessCode();
  if (!code) {
    // No code set: open while developing locally, but locked on the live site,
    // so a forgotten setting never leaves it open.
    return process.env.NODE_ENV === "production" ? deny(request) : NextResponse.next();
  }

  const pass = request.cookies.get(ACCESS_COOKIE)?.value;
  if (pass && safeEqual(pass, accessToken(code))) return NextResponse.next();
  return deny(request);
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
  // Everything except the access page itself, the code check, and Next.js's own files.
  matcher: ["/((?!access$|api/access$|_next/static|_next/image|favicon.ico).*)"],
};

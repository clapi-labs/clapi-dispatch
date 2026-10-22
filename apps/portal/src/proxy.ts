import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

import { SESSION_COOKIE, verifySessionToken } from "@/lib/session";

/**
 * Todo el portal exige sesión salvo la pantalla de login y su API. Las
 * páginas redirigen a /login; la API responde 401.
 */
export function proxy(request: NextRequest) {
  const { pathname, search } = request.nextUrl;
  if (verifySessionToken(request.cookies.get(SESSION_COOKIE)?.value) !== null) {
    return NextResponse.next();
  }

  if (pathname.startsWith("/api/")) {
    return Response.json({ error: "No autenticado" }, { status: 401 });
  }

  const login = new URL("/login", request.url);
  if (pathname !== "/") login.searchParams.set("next", pathname + search);
  return NextResponse.redirect(login);
}

export const config = {
  matcher: ["/((?!login|api/auth|_next/static|_next/image|favicon.ico).*)"],
};

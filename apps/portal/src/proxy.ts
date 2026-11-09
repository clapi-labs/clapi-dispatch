import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

import { isActiveUser } from "@/lib/active-user";
import { authDisabled, isSimulatorPath, SESSION_COOKIE, verifySessionToken } from "@/lib/session";

/**
 * Todo el portal exige sesión salvo la pantalla de login y su API. Las
 * páginas redirigen a /login; la API responde 401. La sesión vale solo si el
 * usuario sigue activo: desactivarlo lo saca del portal sin esperar a que
 * venza la cookie.
 */
export async function proxy(request: NextRequest) {
  const { pathname, search } = request.nextUrl;
  // El simulador pide sesión aunque el login esté apagado (AUTH_DISABLED): desde
  // ahí se crean pedidos y se reinicia lo simulado.
  if (authDisabled() && !isSimulatorPath(pathname)) return NextResponse.next();

  const cookie = request.cookies.get(SESSION_COOKIE)?.value;
  const userId = verifySessionToken(cookie);
  if (userId !== null && (await isActiveUser(userId))) return NextResponse.next();

  const response = pathname.startsWith("/api/")
    ? NextResponse.json({ error: "No autenticado" }, { status: 401 })
    : NextResponse.redirect(loginUrl(request, pathname, search));
  // Una cookie de un usuario desactivado ya no sirve: se borra.
  if (cookie) response.cookies.set(SESSION_COOKIE, "", { httpOnly: true, path: "/", maxAge: 0 });
  return response;
}

function loginUrl(request: NextRequest, pathname: string, search: string) {
  const login = new URL("/login", request.url);
  if (pathname !== "/") login.searchParams.set("next", pathname + search);
  return login;
}

export const config = {
  matcher: ["/((?!login|api/auth|_next/static|_next/image|favicon.ico).*)"],
};

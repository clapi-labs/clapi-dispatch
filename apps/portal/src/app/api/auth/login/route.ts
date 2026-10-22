import { verifyPassword } from "@dispatch/shared/auth/password";
import { NextResponse } from "next/server";

import { findUserByEmail } from "@/db/queries/users";
import { clearFailures, isBlocked, recordFailure } from "@/lib/rate-limit";
import { createSessionToken, SESSION_COOKIE, SESSION_MAX_AGE } from "@/lib/session";

export const dynamic = "force-dynamic";

// Hash de una contraseña inventada: cuando el correo no existe se compara
// igual, para que responder tarde o temprano no revele qué correos hay.
const DUMMY_HASH = "scrypt$AAAAAAAAAAAAAAAAAAAAAA==$" + "A".repeat(86) + "==";

export async function POST(request: Request) {
  const body = await request.json().catch(() => ({}));
  const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
  const password = typeof body.password === "string" ? body.password : "";
  if (!email || !password) {
    return Response.json({ error: "Falta correo o contraseña" }, { status: 400 });
  }

  const ip = request.headers.get("x-forwarded-for")?.split(",")[0].trim() ?? "local";
  const key = `${email}|${ip}`;
  if (isBlocked(key)) {
    return Response.json({ error: "Demasiados intentos. Prueba de nuevo en 15 minutos." }, { status: 429 });
  }

  const user = await findUserByEmail(email);
  const valid = await verifyPassword(password, user?.passwordHash ?? DUMMY_HASH);
  if (!user || !user.active || !valid) {
    recordFailure(key);
    return Response.json({ error: "Correo o contraseña incorrectos" }, { status: 401 });
  }

  clearFailures(key);
  const response = NextResponse.json({ ok: true, name: user.name });
  response.cookies.set(SESSION_COOKIE, createSessionToken(user.id), {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: SESSION_MAX_AGE,
  });
  return response;
}

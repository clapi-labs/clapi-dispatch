import { eq } from "drizzle-orm";

import { db, schema } from "@dispatch/shared/db";

import { currentSession } from "@/lib/auth";
import { authDisabled } from "@/lib/session";

/**
 * Quién ve lo de administración (por ahora, «Salud del sistema»). El portal
 * no tiene roles: son los correos de `PORTAL_ADMIN_EMAILS`, separados por coma.
 * Sin la variable, cualquiera con sesión (como el resto del portal).
 */
export function adminEmails(env: Record<string, string | undefined> = process.env): string[] | null {
  const list = (env.PORTAL_ADMIN_EMAILS ?? "")
    .split(",")
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);
  return list.length > 0 ? list : null;
}

/**
 * Quién puede crear usuarios y generar enlaces de contraseña: solo los de
 * `PORTAL_ADMIN_EMAILS` (usuario o correo, en minúsculas). Sin la variable,
 * nadie: con ella vacía cualquiera con sesión podría quedarse con la cuenta de
 * otro. Con el login apagado (staging) sí, como `isAdmin`.
 */
export async function isUserAdmin(): Promise<boolean> {
  if (authDisabled()) return true;
  if (!adminEmails()) return false;
  return isAdmin();
}

export async function isAdmin(): Promise<boolean> {
  if (authDisabled()) return true;
  const session = await currentSession();
  if (!session) return false;
  const allowed = adminEmails();
  if (!allowed) return true;
  const [user] = await db.select({ email: schema.users.email }).from(schema.users).where(eq(schema.users.id, session.userId)).limit(1);
  return !!user && allowed.includes(user.email.toLowerCase());
}

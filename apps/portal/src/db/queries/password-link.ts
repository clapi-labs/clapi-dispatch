import { and, eq } from "drizzle-orm";

import { hashPassword } from "@dispatch/shared/auth/password";
import { db, schema } from "@dispatch/shared/db";

import { closeUserSessions } from "@/lib/auth";
import { passwordFingerprint, sameFingerprint, verifyPasswordLinkToken } from "@/lib/password-link";

/** El usuario al que le sirve este enlace: firma válida, sin vencer, usuario
 *  activo y contraseña sin cambiar desde que se emitió (un solo uso). */
export async function userForPasswordLink(token: string | undefined) {
  const parsed = verifyPasswordLinkToken(token);
  if (!parsed) return null;
  const [user] = await db.select().from(schema.users).where(eq(schema.users.id, parsed.userId));
  if (!user || !user.active) return null;
  return sameFingerprint(passwordFingerprint(user.passwordHash), parsed.fingerprint) ? user : null;
}

/**
 * Guarda la contraseña nueva (scrypt) y cierra todas las sesiones del usuario.
 * El UPDATE solo pega si la contraseña sigue siendo la de cuando se emitió el
 * enlace: dos envíos a la vez no pueden usarlo los dos. Devuelve null si el
 * enlace ya no sirve.
 */
export async function setPasswordWithLink(token: string | undefined, newPassword: string) {
  const user = await userForPasswordLink(token);
  if (!user) return null;
  const passwordHash = await hashPassword(newPassword);
  const [updated] = await db
    .update(schema.users)
    .set({ passwordHash })
    .where(and(eq(schema.users.id, user.id), eq(schema.users.passwordHash, user.passwordHash)))
    .returning({ id: schema.users.id, email: schema.users.email, name: schema.users.name });
  if (!updated) return null;
  await closeUserSessions(updated.id);
  return updated;
}

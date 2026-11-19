import { randomBytes } from "node:crypto";

import { asc, eq } from "drizzle-orm";

import { hashPassword } from "@dispatch/shared/auth/password";
import { db, schema } from "@dispatch/shared/db";

export type PortalUser = { id: number; email: string; name: string; active: boolean };

export async function listPortalUsers(): Promise<PortalUser[]> {
  return db
    .select({ id: schema.users.id, email: schema.users.email, name: schema.users.name, active: schema.users.active })
    .from(schema.users)
    .orderBy(asc(schema.users.id));
}

/** Crea el usuario con una contraseña aleatoria que nadie conoce: entra por el
 *  enlace de contraseña. Devuelve null si ese usuario ya existe. */
export async function createPortalUser(login: string, name: string): Promise<PortalUser | null> {
  const passwordHash = await hashPassword(randomBytes(32).toString("base64url"));
  const [row] = await db
    .insert(schema.users)
    .values({ email: login, name, passwordHash })
    .onConflictDoNothing({ target: schema.users.email })
    .returning({ id: schema.users.id, email: schema.users.email, name: schema.users.name, active: schema.users.active });
  return row ?? null;
}

export async function findPortalUserById(id: number) {
  const [user] = await db.select().from(schema.users).where(eq(schema.users.id, id));
  return user ?? null;
}

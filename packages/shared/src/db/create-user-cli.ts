import { eq } from "drizzle-orm";

import { hashPassword } from "../auth/password";
import { db, schema } from "./client";

/**
 * Crea (o cambia la contraseña de) un usuario del portal.
 *
 *   npm run user:create -- ana@agencia.com "Ana Pérez"
 *
 * La contraseña se lee de la variable USER_PASSWORD (no por argumento, para
 * que no quede en el historial de la terminal).
 */
async function main() {
  const [emailArg, name = ""] = process.argv.slice(2);
  const password = process.env.USER_PASSWORD;
  if (!emailArg || !password) {
    throw new Error('Uso: USER_PASSWORD=... npm run user:create -- correo@dominio.com "Nombre"');
  }
  if (password.length < 10) throw new Error("La contraseña debe tener al menos 10 caracteres.");

  const email = emailArg.trim().toLowerCase();
  const passwordHash = await hashPassword(password);

  const [existing] = await db.select({ id: schema.users.id }).from(schema.users).where(eq(schema.users.email, email));
  if (existing) {
    await db.update(schema.users).set({ passwordHash, active: true }).where(eq(schema.users.id, existing.id));
    console.log(`Contraseña actualizada: ${email}`);
  } else {
    await db.insert(schema.users).values({ email, name: name || email, passwordHash });
    console.log(`Usuario creado: ${email}`);
  }
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err.message ?? err);
    process.exit(1);
  });

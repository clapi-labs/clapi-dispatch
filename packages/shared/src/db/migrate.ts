import { fileURLToPath } from "node:url";

import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Pool } from "pg";

/**
 * Aplica las migraciones versionadas de `packages/shared/drizzle`. Reemplaza
 * a `db:push`: es idempotente y se corre en cada despliegue antes de levantar
 * la versión nueva. Siempre por TCP (`pg`), nunca por el driver HTTP de Neon.
 */
async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("Falta DATABASE_URL.");

  const pool = new Pool({ connectionString: url });
  try {
    await migrate(drizzle(pool), {
      migrationsFolder: fileURLToPath(new URL("../../drizzle", import.meta.url)),
    });
    console.log("Migraciones aplicadas.");
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

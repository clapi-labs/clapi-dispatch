import { db, schema } from "@dispatch/shared/db";
import { eq } from "drizzle-orm";

export async function findUserByEmail(email: string) {
  const [user] = await db.select().from(schema.users).where(eq(schema.users.email, email));
  return user ?? null;
}

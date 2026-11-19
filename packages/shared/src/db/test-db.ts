/**
 * Base de pruebas para las suites de integración (`*.integration.test.ts`) de
 * shared, bot y portal: Postgres de verdad, ya migrado, de usar y tirar.
 *
 *   import { integrationSkip, resetDatabase, closeTestDatabase, factories } from "@dispatch/shared/db/test-db";
 *   describe("…", { skip: integrationSkip }, () => {
 *     beforeEach(resetDatabase);
 *     after(closeTestDatabase);
 *   });
 *
 * Sin `TEST_DATABASE_URL` las suites se saltan; con `REQUIRE_TEST_DATABASE=1`
 * (CI) en cambio fallan, para que nunca se salten sin que nadie lo note.
 * Cómo levantarla en local: `docs/OPERACION.md`, «Pruebas de integración».
 *
 * Al importar este módulo se apunta `DATABASE_URL` a la base de pruebas, así
 * que el código que se prueba (`db`, el dominio) usa esa y no otra.
 *
 * Las suites comparten una sola base y se vacía entera: corren de a una
 * (`npm run test:integration` usa `--test-concurrency=1`).
 */
import { sql } from "drizzle-orm";

import { db } from "./client";
import {
  assignments,
  conversations,
  couriers,
  restaurants,
  trips,
  type CourierStatus,
  type TripStatus,
} from "./schema";

/** Se vacían tablas: solo contra una base cuyo nombre contenga «test». */
export function assertTestDatabaseUrl(url: string): void {
  let name: string;
  try {
    name = decodeURIComponent(new URL(url).pathname.replace(/^\//, ""));
  } catch {
    throw new Error("TEST_DATABASE_URL no es una URL de Postgres válida");
  }
  if (!/test/i.test(name)) {
    throw new Error(`TEST_DATABASE_URL tiene que apuntar a una base cuyo nombre contenga «test» (la de ahora: «${name}»)`);
  }
}

const url = process.env.TEST_DATABASE_URL;

if (!url && process.env.REQUIRE_TEST_DATABASE === "1") {
  throw new Error("Falta TEST_DATABASE_URL y REQUIRE_TEST_DATABASE=1: las pruebas de integración no pueden saltarse");
}
if (url) {
  assertTestDatabaseUrl(url);
  process.env.DATABASE_URL = url;
}

/** Para `describe(…, { skip: integrationSkip })`. */
export const integrationSkip: string | false = url ? false : "falta TEST_DATABASE_URL";

type Row = { tablename: string };

/** Vacía todas las tablas de la base y reinicia sus ids. No toca el control de
 *  migraciones (vive en el esquema `drizzle`). */
export async function resetDatabase(): Promise<void> {
  if (!url) throw new Error("resetDatabase sin TEST_DATABASE_URL");
  const { rows } = await db.execute<Row>(sql`SELECT tablename FROM pg_tables WHERE schemaname = 'public'`);
  if (rows.length === 0) throw new Error("La base de pruebas no tiene tablas: corre db:migrate contra ella primero");
  const list = rows.map((r) => `"${r.tablename.replace(/"/g, '""')}"`).join(", ");
  await db.execute(sql.raw(`TRUNCATE TABLE ${list} RESTART IDENTITY CASCADE`));
}

/** Cierra el pool para que el proceso de prueba termine. */
export async function closeTestDatabase(): Promise<void> {
  await (db as unknown as { $client?: { end?: () => Promise<void> } }).$client?.end?.();
}

// ---------------------------------------------------------------------------
// Factories mínimas: lo justo para satisfacer los `notNull`; lo demás por `over`.
// Los teléfonos y códigos salen de un contador, así que no chocan entre filas.
// ---------------------------------------------------------------------------

let seq = 0;
const next = () => ++seq;
const phone = () => `5730${String(next()).padStart(8, "0")}`;

type Insert<T extends { $inferInsert: unknown }> = Partial<T["$inferInsert"]>;

export async function createRestaurant(over: Insert<typeof restaurants> = {}) {
  const n = next();
  const [row] = await db.insert(restaurants).values({ name: `Restaurante ${n}`, phone: phone(), ...over }).returning();
  return row;
}

export async function createConversation(over: Insert<typeof conversations> = {}) {
  const [row] = await db.insert(conversations).values({ phone: phone(), ...over }).returning();
  return row;
}

export async function createCourier(over: Insert<typeof couriers> & { status?: CourierStatus } = {}) {
  const n = next();
  const [row] = await db.insert(couriers).values({ name: `Moto ${n}`, phone: phone(), status: "available", ...over }).returning();
  return row;
}

/** Sin `conversationId` crea una conversación; sin `restaurantId` no liga restaurante. */
export async function createTrip(over: Insert<typeof trips> & { status?: TripStatus } = {}) {
  const n = next();
  const conversationId = over.conversationId === undefined ? (await createConversation()).id : over.conversationId;
  const [row] = await db
    .insert(trips)
    .values({
      code: `T${n}`,
      status: "pending",
      originRestaurantName: "Resto",
      deliveryAddress: "Calle 1 # 2-3",
      ...over,
      conversationId,
    })
    .returning();
  return row;
}

/** La fila de `assignments` tal cual, sin pasar por `assignTripTo` (no cambia el
 *  estado del viaje ni de la moto): para armar fases a mano con las horas. */
export async function createAssignment(
  over: Insert<typeof assignments> & { tripId: number; courierId: number; courierName?: string },
) {
  const [row] = await db
    .insert(assignments)
    .values({ courierName: `Moto ${over.courierId}`, ...over })
    .returning();
  return row;
}

export const factories = { createRestaurant, createConversation, createCourier, createTrip, createAssignment };

/**
 * Cuántos mensajes manda el bot por servicio y cuánto costarían.
 *
 *   npm run bot:mensajes                  # últimos 30 días
 *   npm run bot:mensajes -- 2026-10-01    # desde esa fecha
 *
 * Cuenta lo que el bot envió (no los «leído» ni «escribiendo…», que Meta no
 * cobra), separado entre restaurantes y motorizados, y lo divide entre los
 * servicios creados en el mismo periodo. El precio por mensaje y los gratis
 * por mes son los de Colombia para mensajes de servicio (docs/BOT.md,
 * «Mensajes por servicio»); cámbialos aquí si Meta los cambia.
 */
import { and, eq, gte, sql } from "drizzle-orm";

import { db, schema } from "@dispatch/shared/db";

const USD_PER_MESSAGE = 0.0008;
const FREE_PER_MONTH = 1000;

const since = process.argv[2] ? new Date(`${process.argv[2]}T00:00:00-05:00`) : new Date(Date.now() - 30 * 86_400_000);

async function main() {
  const last10 = sql`right(regexp_replace(${schema.conversations.phone}, '\\D', '', 'g'), 10)`;
  const isCourier = sql<boolean>`exists (select 1 from ${schema.couriers} where right(regexp_replace(${schema.couriers.phone}, '\\D', '', 'g'), 10) = ${last10})`;

  const sent = await db
    .select({ courier: isCourier, count: sql<number>`count(*)::int` })
    .from(schema.messages)
    .innerJoin(schema.conversations, eq(schema.conversations.id, schema.messages.conversationId))
    .where(and(eq(schema.messages.role, "bot"), gte(schema.messages.createdAt, since)))
    .groupBy(isCourier);

  const [trips] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(schema.trips)
    .where(gte(schema.trips.createdAt, since));

  const toCouriers = sent.find((r) => r.courier)?.count ?? 0;
  const toRestaurants = sent.find((r) => !r.courier)?.count ?? 0;
  const total = toCouriers + toRestaurants;
  const services = trips?.count ?? 0;
  const per = (n: number) => (services ? (n / services).toFixed(1) : "—");

  const days = Math.max(1, (Date.now() - since.getTime()) / 86_400_000);
  const perMonth = (total / days) * 30;
  const billable = Math.max(0, perMonth - FREE_PER_MONTH);

  console.log(`Desde ${since.toLocaleDateString("es-CO", { timeZone: "America/Bogota" })} (${days.toFixed(0)} días)\n`);
  console.log(`Servicios creados:        ${services}`);
  console.log(`Mensajes a restaurantes:  ${toRestaurants}  (${per(toRestaurants)} por servicio)`);
  console.log(`Mensajes a motorizados:   ${toCouriers}  (${per(toCouriers)} por servicio)`);
  console.log(`Total:                    ${total}  (${per(total)} por servicio)\n`);
  console.log(`Al mes, a este ritmo:     ${Math.round(perMonth)} mensajes`);
  console.log(`Cobrados (pasados ${FREE_PER_MONTH}):  ${Math.round(billable)} × US$${USD_PER_MESSAGE} = US$${(billable * USD_PER_MESSAGE).toFixed(2)} al mes`);
  process.exit(0);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});

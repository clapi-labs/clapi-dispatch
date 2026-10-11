import { and, desc, eq, ne } from "drizzle-orm";

import { db, schema } from "@dispatch/shared/db";

/** "300 123 4567" → "573001234567": el formato en que WhatsApp identifica el
 *  número, para que el bot reconozca al motorizado cuando escriba. */
function toWaId(phone: string) {
  const digits = phone.replace(/\D/g, "");
  return digits.length === 10 ? `57${digits}` : digits;
}

export type CourierRow = typeof schema.couriers.$inferSelect;

export async function listCouriers(): Promise<CourierRow[]> {
  return db.select().from(schema.couriers).where(eq(schema.couriers.active, true)).orderBy(desc(schema.couriers.createdAt));
}

export async function createCourier(input: { name: string; phone: string; lat?: number; lng?: number }) {
  const [courier] = await db
    .insert(schema.couriers)
    .values({
      name: input.name,
      phone: toWaId(input.phone),
      lat: input.lat ?? null,
      lng: input.lng ?? null,
      status: "available",
      locationUpdatedAt: input.lat !== undefined ? new Date() : null,
      shiftStartedAt: new Date(),
    })
    .returning();
  return courier;
}

export async function updateCourierStatus(id: number, status: schema.CourierStatus) {
  const [courier] = await db.update(schema.couriers).set({ status }).where(eq(schema.couriers.id, id)).returning();
  return courier;
}

export type CourierProfile = Pick<
  typeof schema.courierProfiles.$inferSelect,
  "vehiclePlate" | "vehicleType" | "documentId" | "emergencyContactName" | "emergencyContactPhone"
>;

/** La ficha de "Ver más": vehículo y datos personales. Un motorizado al que
 *  todavía no se le ha llenado no tiene fila, y sale con todo vacío. */
export async function getCourierProfile(courierId: number): Promise<CourierProfile> {
  const [row] = await db.select().from(schema.courierProfiles).where(eq(schema.courierProfiles.courierId, courierId)).limit(1);
  return {
    vehiclePlate: row?.vehiclePlate ?? null,
    vehicleType: row?.vehicleType ?? null,
    documentId: row?.documentId ?? null,
    emergencyContactName: row?.emergencyContactName ?? null,
    emergencyContactPhone: row?.emergencyContactPhone ?? null,
  };
}

export async function saveCourierProfile(courierId: number, profile: CourierProfile): Promise<CourierProfile> {
  await db
    .insert(schema.courierProfiles)
    .values({ courierId, ...profile })
    .onConflictDoUpdate({ target: schema.courierProfiles.courierId, set: { ...profile, updatedAt: new Date() } });
  return profile;
}

/** Quitar de la flota sin borrar: su nombre sigue en el arqueo de los viajes
 *  que ya hizo. Un motorizado en un viaje no se puede quitar. */
export async function removeCourier(id: number) {
  await db
    .update(schema.couriers)
    .set({ active: false, status: "offline" })
    .where(and(eq(schema.couriers.id, id), ne(schema.couriers.status, "busy")));
}

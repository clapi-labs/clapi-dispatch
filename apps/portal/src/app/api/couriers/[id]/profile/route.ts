import { getCourierProfile, saveCourierProfile } from "@/db/queries/couriers";
import { readJsonObject } from "@/lib/json";

export const dynamic = "force-dynamic";

/** Texto libre de la ficha: recortado, con tope de largo, y vacío = sin dato. */
function text(value: unknown, max: number): string | null {
  if (typeof value !== "string") return null;
  return value.trim().slice(0, max) || null;
}

export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return Response.json(await getCourierProfile(Number(id)));
}

export async function PUT(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const body = await readJsonObject(request);
  // Sin un objeto no hay nada que guardar: con `{}` se borraría la ficha entera.
  if (!body) return Response.json({ error: "Cuerpo inválido" }, { status: 400 });

  const profile = await saveCourierProfile(Number(id), {
    // La placa siempre igual: "abc 12d" y "ABC-12D" son la misma moto.
    vehiclePlate: text(body.vehiclePlate, 12)?.toUpperCase().replace(/[^A-Z0-9]/g, "") || null,
    vehicleType: text(body.vehicleType, 60),
    documentId: text(body.documentId, 20),
    emergencyContactName: text(body.emergencyContactName, 60),
    emergencyContactPhone: text(body.emergencyContactPhone, 20),
  });

  return Response.json(profile);
}

import { ensureGpsDeviceId } from "@/db/queries/couriers";

export const dynamic = "force-dynamic";

/** El identificador que se configura en la app de su celular. */
export async function POST(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return Response.json({ gpsDeviceId: await ensureGpsDeviceId(Number(id)) });
}

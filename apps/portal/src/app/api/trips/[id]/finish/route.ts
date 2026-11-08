import { finishTrip } from "@dispatch/shared/db";

import { notifyBot } from "@/lib/bot";

export const dynamic = "force-dynamic";

/** «Ya volvió», marcado desde el portal: el respaldo del botón «Ya volví». La
 *  moto vuelve a la cola y toma el siguiente pendiente si hay. */
export async function POST(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const result = await finishTrip(Number((await params).id));
  if (!result) return Response.json({ ok: false }, { status: 409 });

  await notifyBot({ assigned: result.newlyAssigned });
  return Response.json({ ok: true });
}

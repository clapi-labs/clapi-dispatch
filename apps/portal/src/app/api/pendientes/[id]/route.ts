import { getReturnDebt, resolveDebtClaim, resolveReturnDebtGroup } from "@dispatch/shared/db";

import { currentSession } from "@/lib/auth";
import { callBot } from "@/lib/bot";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ id: string }> };

/**
 * Lo que la central hace con un pendiente (y su grupo: mismo domiciliario,
 * restaurante y motivo) o con un reclamo del restaurante (#61):
 * - `resolve`: lo marca resuelto; pasa al historial con quién lo cerró.
 * - `nudge`: «Mandar ya», le escribe al domiciliario que pase por el
 *   restaurante, con el botón que lo cierra.
 * - `handle_claim`: «Lo resuelvo yo», marca como atendido un reclamo del restaurante.
 */
export async function POST(request: Request, { params }: Params) {
  const id = Number((await params).id);
  const { action } = (await request.json().catch(() => ({}))) as { action?: unknown };
  if (action === "handle_claim") {
    const session = await currentSession();
    const closed = Number.isInteger(id) ? await resolveDebtClaim(id, session?.userId ?? null) : null;
    if (!closed) return Response.json({ error: "Ese reclamo ya estaba atendido" }, { status: 404 });
    return Response.json({ ok: true });
  }
  const debt = Number.isInteger(id) ? await getReturnDebt(id) : null;
  if (!debt) return Response.json({ error: "Ese pendiente ya no existe" }, { status: 404 });
  if (debt.resolvedAt) return Response.json({ error: "Ya estaba resuelto" }, { status: 409 });

  if (action === "resolve") {
    const session = await currentSession();
    const closed = await resolveReturnDebtGroup(id, { kind: "central", userId: session?.userId ?? null });
    return Response.json({ ok: true, closed: closed.map((d) => d.id) });
  }
  if (action === "nudge") {
    const sent = await callBot("/api/internal/notify", { debtNudge: id });
    if (!sent.ok) return Response.json({ error: sent.reason === "closed" ? "Ya estaba resuelto" : "No se pudo enviar el WhatsApp" }, { status: 502 });
    return Response.json({ ok: true });
  }
  return Response.json({ error: "Acción inválida" }, { status: 400 });
}

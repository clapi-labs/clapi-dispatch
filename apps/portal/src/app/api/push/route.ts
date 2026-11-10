import { deleteSubscription, getVapidKeys, saveSubscription } from "@dispatch/shared/db";

import { currentSession } from "@/lib/auth";

export const dynamic = "force-dynamic";

/**
 * Las alertas al celular de esta sesión (docs/INTERVENCION-MANUAL.md,
 * «Alertas al celular»). GET da la llave pública con que el navegador se
 * suscribe; POST guarda la suscripción; DELETE la quita.
 */

export async function GET() {
  const session = await currentSession();
  if (!session) return Response.json({ error: "No autenticado" }, { status: 401 });
  const { publicKey } = await getVapidKeys();
  return Response.json({ publicKey, sessionId: session.sessionId });
}

type SubscriptionJson = { endpoint: string; keys: { p256dh: string; auth: string } };

function parse(value: unknown): SubscriptionJson | null {
  const v = value as Partial<SubscriptionJson> | null;
  if (!v || typeof v.endpoint !== "string" || !v.keys) return null;
  const { p256dh, auth } = v.keys;
  if (typeof p256dh !== "string" || typeof auth !== "string") return null;
  if (!v.endpoint.startsWith("https://") || v.endpoint.length > 2000 || p256dh.length > 200 || auth.length > 100) return null;
  return { endpoint: v.endpoint, keys: { p256dh, auth } };
}

export async function POST(request: Request) {
  const session = await currentSession();
  if (!session) return Response.json({ error: "No autenticado" }, { status: 401 });
  const body = await request.json().catch(() => null);
  const sub = parse(body?.subscription);
  if (!sub) return Response.json({ error: "Suscripción inválida" }, { status: 400 });

  // El portal tal como lo ve el celular (https://…): va como remitente de cada aviso.
  const origin = request.headers.get("origin") ?? new URL(request.url).origin;
  await saveSubscription({ sessionId: session.sessionId, endpoint: sub.endpoint, p256dh: sub.keys.p256dh, auth: sub.keys.auth, origin });
  return Response.json({ ok: true });
}

export async function DELETE(request: Request) {
  const session = await currentSession();
  if (!session) return Response.json({ error: "No autenticado" }, { status: 401 });
  const body = await request.json().catch(() => null);
  if (typeof body?.endpoint !== "string") return Response.json({ error: "Falta endpoint" }, { status: 400 });
  await deleteSubscription(session.sessionId, body.endpoint);
  return Response.json({ ok: true });
}

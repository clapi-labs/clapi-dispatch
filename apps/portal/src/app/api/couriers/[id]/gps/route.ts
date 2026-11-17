import { ensureGpsDeviceId } from "@/db/queries/couriers";
import { callBot } from "@/lib/bot";

export const dynamic = "force-dynamic";

function resolveGpsUrl(request: Request): string | undefined {
  const host = process.env.BOT_HOST?.replace(/^https?:\/\//, "").replace(/\/+$/, "");
  if (host) return `https://${host}/api/gps`;
  const reqHost = (request.headers.get("x-forwarded-host") ?? request.headers.get("host") ?? "").split(",")[0].trim();
  if (!reqHost || /^(localhost|127\.0\.0\.1)(:\d+)?$/i.test(reqHost)) return undefined;
  const botHost = reqHost.startsWith("bot.") ? reqHost : `bot.${reqHost}`;
  return `https://${botHost}/api/gps`;
}

/** El identificador que se configura en la app de su celular. */
export async function POST(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return Response.json({ gpsDeviceId: await ensureGpsDeviceId(Number(id)) });
}

/**
 * Envía al domiciliario por WhatsApp su identificador, la URL del servidor y
 * los ajustes de Traccar Client (#53). Si no ha escrito en las últimas 24 h,
 * avisa («Pídele que escriba "hola" primero»).
 */
export async function PUT(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const courierId = Number((await params).id);
  const gpsDeviceId = await ensureGpsDeviceId(courierId);
  const gpsUrl = resolveGpsUrl(request);
  const sent = await callBot("/api/internal/notify", { courierGps: courierId, gpsUrl });
  if (!sent.ok) {
    if (sent.reason === "outside_window") {
      return Response.json({ gpsDeviceId, error: 'Pídele que escriba "hola" primero.' }, { status: 409 });
    }
    const detail = sent.reason === "no_url" ? "Falta configurar BOT_HOST en el servidor." : "No se pudo enviar por WhatsApp.";
    return Response.json({ gpsDeviceId, error: detail }, { status: 502 });
  }
  return Response.json({ ok: true, gpsDeviceId });
}

/**
 * El portal no le habla a Meta: le pide al bot que envíe (el único con las
 * credenciales de WhatsApp). Necesita BOT_URL e INTERNAL_SECRET — el mismo
 * secreto que tiene el bot.
 *
 * Si faltan, el cambio de estado igual se guarda: lo que no sale es el
 * WhatsApp. Un aviso que no se pudo mandar no puede bloquear el tablero.
 */
export async function callBot(path: string, body: unknown): Promise<{ ok: boolean; reason?: string }> {
  const url = process.env.BOT_URL;
  const secret = process.env.INTERNAL_SECRET;
  if (!url || !secret) {
    console.warn("[portal] falta BOT_URL o INTERNAL_SECRET: no se envió nada por WhatsApp");
    return { ok: false, reason: "no_bot" };
  }

  const base = (/^https?:\/\//.test(url) ? url : `https://${url}`).replace(/\/+$/, "");
  try {
    const res = await fetch(`${base}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-internal-secret": secret },
      body: JSON.stringify(body),
    });
    const data = await res.json().catch(() => ({}));
    // 401 = el INTERNAL_SECRET del portal no coincide con el del bot.
    return { ok: res.ok, reason: data?.reason ?? (res.ok ? undefined : res.status === 401 ? "bad_secret" : `http_${res.status}`) };
  } catch (error) {
    return { ok: false, reason: String(error) };
  }
}

/** Avisos por WhatsApp de viajes que cambiaron de estado desde el portal. */
export function notifyBot(change: { assigned?: number[]; delivered?: number[]; unassigned?: { tripId: number; courierId: number }[] }) {
  if (!change.assigned?.length && !change.delivered?.length && !change.unassigned?.length) return Promise.resolve({ ok: true });
  return callBot("/api/internal/notify", change);
}

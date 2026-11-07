// Los avisos de la demo por WhatsApp, con el mismo formato que
// apps/bot/src/bot/notify.ts. Todas las fichas de las motos de ejemplo le
// llegan a un solo número (DEMO_MOTORIZADO), que hace de toda la flota.
// Sin las variables de WhatsApp, solo se registran en la bitácora.

const { WHATSAPP_API_VERSION = "v21.0", WHATSAPP_PHONE_NUMBER_ID, WHATSAPP_ACCESS_TOKEN, DEMO_MOTORIZADO } = process.env;

export const BOTON_ENTREGAR = "sim:entregar:";
export const motorizadoDemo = DEMO_MOTORIZADO?.replace(/\D/g, "") || null;
export const whatsappActivo = Boolean(WHATSAPP_PHONE_NUMBER_ID && WHATSAPP_ACCESS_TOKEN);

const cop = (n) => new Intl.NumberFormat("es-CO", { style: "currency", currency: "COP", maximumFractionDigits: 0 }).format(n);
const telefono = (t) => {
  const d = String(t ?? "").replace(/\D/g, "").slice(-10);
  return d.length === 10 ? `${d.slice(0, 3)} ${d.slice(3, 6)} ${d.slice(6)}` : t;
};
const hora = () => new Date().toLocaleTimeString("es-CO", { hour: "2-digit", minute: "2-digit", timeZone: "America/Bogota" });

async function enviar(to, cuerpo, citar) {
  if (!whatsappActivo || !to) return { ok: false, motivo: "WhatsApp sin configurar" };
  try {
    const r = await fetch(`https://graph.facebook.com/${WHATSAPP_API_VERSION}/${WHATSAPP_PHONE_NUMBER_ID}/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${WHATSAPP_ACCESS_TOKEN}` },
      body: JSON.stringify({ messaging_product: "whatsapp", to, ...(citar ? { context: { message_id: citar } } : {}), ...cuerpo }),
    });
    const datos = await r.json().catch(() => null);
    const enviado = cuerpo.text?.body ?? cuerpo.interactive?.body.text;
    return r.ok ? { ok: true, texto: enviado, para: `${to === motorizadoDemo ? "Motorizado demo" : "Restaurante"} (simulador)` } : { ok: false, motivo: datos?.error?.message ?? `HTTP ${r.status}` };
  } catch (e) {
    return { ok: false, motivo: e.message };
  }
}

const texto = (to, body, citar) => enviar(to, { type: "text", text: { body } }, citar);

/** La ficha del motorizado: el texto de notify.ts con el nombre de la moto de ejemplo. */
export function fichaMotorizado(p, moto) {
  const cliente = [p.cliente_nombre, p.cliente_tel && telefono(p.cliente_tel)].filter(Boolean).join(" · ");
  const cobro =
    p.pago === "transferencia" ? "💳 Ya pagado, no cobrar." : p.valor ? `💵 ${p.pago === "efectivo" ? "Cobrar en efectivo" : "Valor del pedido:"} ${cop(p.valor)}` : null;
  const body = [
    `🛵 *Nuevo viaje ${p.codigo} para ${moto.id}*`,
    "",
    `📍 Recoge: ${p.restaurante_nombre}${p.recogida ? ` · ${p.recogida}` : ""}`,
    `🏁 Entrega: ${p.entrega}`,
    cliente ? `📞 Cliente: ${cliente}` : null,
    cobro,
    p.notas ? `📝 ${p.notas}` : null,
    "",
    `🗺️ https://waze.com/ul?ll=${p.cliente[0]},${p.cliente[1]}&navigate=yes`,
    "",
    "Toca el botón cuando termines. Si te toca volver al restaurante (por el cambio, por ejemplo), tócalo al volver 👇",
  ]
    .filter((l) => l !== null)
    .join("\n");
  return enviar(motorizadoDemo, {
    type: "interactive",
    interactive: { type: "button", body: { text: body }, action: { buttons: [{ type: "reply", reply: { id: `${BOTON_ENTREGAR}${p.id}`, title: "Terminé el servicio" } }] } },
  });
}

export const avisoAsignado = (p, moto) =>
  texto(p.restaurante_tel, `✅ Pedido ${p.codigo} asignado${p.tarifa ? ` · ${cop(p.tarifa)}` : ""}\n🛵 Va ${moto.id} · ${telefono(moto.telefono)}`, p.mensaje_origen);

export const avisoTerminadoMotorizado = (p, moto) => texto(motorizadoDemo, `✅ ${p.codigo} terminado. ${moto.id} queda libre 🛵`);

export const avisoEntregado = (p) => texto(p.restaurante_tel, `📦 Pedido ${p.codigo} entregado a las ${hora()} ✅`, p.mensaje_origen);

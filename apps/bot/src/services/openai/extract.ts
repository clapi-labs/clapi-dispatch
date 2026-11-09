import { ambiguousAddress, buildExtractionPrompt, DOUBTFUL_FIELDS, type DoubtfulField, type Interpretation, type OrderDraft } from "@dispatch/shared";

import { env } from "@/env";
import type { DownloadedImage } from "@/services/whatsapp/client";

/** `confirms`: el restaurante aceptó el servicio cotizado (lo dice el modelo;
 *  el código igual verifica que haya una cotización que aceptar). */
/** `query`: el mensaje pregunta algo en vez de pedir (docs/BOT.md, consultas). */
/** `intent`: «cotizar» si solo pregunta el precio, «pedir» si pide el servicio (null: ninguno). */
export type ExtractionOutcome = {
  fields: Interpretation;
  query: "estado" | "cobertura" | null;
  intent: "cotizar" | "pedir" | null;
  confirms: boolean;
  confused: boolean;
  failed: boolean;
};

const NOTHING: Interpretation = { origenRestaurante: null, entregas: [] };

const text = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : null);

/** Lo que el modelo necesita saber del pedido en curso: los datos y la etapa,
 *  sin coordenadas ni ids internos. */
function knownForModel(known: OrderDraft) {
  return {
    etapa: known.etapa,
    soloPrecio: known.soloPrecio ?? false,
    origenRestaurante: known.origenRestaurante,
    entregas: known.entregas.map(({ direccionEntrega, detalleDireccion, esConjunto, telefonoCliente, nombreCliente, valorACobrar, metodoPago, listoEnMinutos, notas, dudas }) => ({
      direccionEntrega,
      detalleDireccion,
      esConjunto,
      telefonoCliente,
      nombreCliente,
      valorACobrar,
      metodoPago,
      listoEnMinutos,
      notas,
      dudas: dudas ?? [],
    })),
  };
}

/**
 * El teléfono del cliente en la forma que se guarda: los 10 dígitos de un
 * celular colombiano, sin el indicativo («+57 300 5550101» → «3005550101»).
 * `doubtful` si no da 10 dígitos (le falta o le sobra uno, o es un fijo
 * viejo): se guarda igual, pero el restaurante lo confirma.
 */
export function customerPhone(raw: unknown): { phone: string | null; doubtful: boolean } {
  let digits = typeof raw === "string" || typeof raw === "number" ? String(raw).replace(/\D/g, "") : "";
  if (digits.length === 12 && digits.startsWith("57")) digits = digits.slice(2);
  if (digits.length < 7) return { phone: null, doubtful: false };
  return { phone: digits, doubtful: digits.length !== 10 };
}

/** Una entrega tal como la devolvió el modelo, validada campo por campo. */
export function parseDelivery(raw: Record<string, unknown>): Interpretation["entregas"][number] {
  const valor =
    typeof raw.valorACobrar === "number"
      ? raw.valorACobrar
      : typeof raw.valorACobrar === "string" && /\d/.test(raw.valorACobrar)
        ? Number(raw.valorACobrar.replace(/\D/g, ""))
        : null;
  const listo = typeof raw.listoEnMinutos === "number" ? Math.round(raw.listoEnMinutos) : null;
  const phone = customerPhone(raw.telefonoCliente);
  // El valor y el pago no se le preguntan al restaurante: no se dudan.
  const doubts = Array.isArray(raw.dudas)
    ? raw.dudas.filter((k): k is DoubtfulField => (DOUBTFUL_FIELDS as readonly unknown[]).includes(k) && k !== "valorACobrar" && k !== "metodoPago")
    : [];
  if (phone.doubtful) doubts.push("telefonoCliente");
  // Sin tipo de vía («la 42 con 83») el mapa puede ubicarla en otro lado: se confirma.
  if (ambiguousAddress(text(raw.direccionEntrega))) doubts.push("direccionEntrega");
  return {
    direccionEntrega: text(raw.direccionEntrega),
    telefonoCliente: phone.phone,
    nombreCliente: text(raw.nombreCliente),
    valorACobrar: valor && valor > 0 ? valor : null,
    metodoPago: raw.metodoPago === "efectivo" || raw.metodoPago === "transferencia" ? raw.metodoPago : null,
    listoEnMinutos: listo !== null && listo >= 0 && listo <= MAX_LISTO_MIN ? listo : null,
    notas: text(raw.notas),
    detalleDireccion: text(raw.detalleDireccion),
    esConjunto: typeof raw.esConjunto === "boolean" ? raw.esConjunto : null,
    barrio: text(raw.barrio),
    // Solo los nombres conocidos y que tengan un valor: dudar de un null no aporta.
    dudas: doubts.length ? [...new Set(doubts)] : null,
  };
}

const TIMEOUT_MS = 30_000; // una foto en alta resolución tarda más que un texto
const RETRY_DELAY_MS = 800;

/** Fallos que valen un segundo intento: red, tiempo agotado, 429 y 5xx. Un 4xx
 *  (llave mala, petición inválida) se repetiría igual. */
function isTransient(status: number) {
  return status === 429 || status >= 500;
}

/** "19:05": para que el modelo convierta "lista a las 7:40" en minutos. */
function horaCali() {
  return new Intl.DateTimeFormat("es-CO", { timeZone: "America/Bogota", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(new Date());
}

/** Más de 3 horas no es un domicilio que se esté pidiendo ahora: mejor repreguntar. */
const MAX_LISTO_MIN = 180;

/**
 * Una sola llamada con salida JSON forzada. Recibe lo ya capturado para que
 * el modelo sepa a qué campo pertenece un dato suelto ("3001234567" → el
 * teléfono que faltaba). Si OpenAI falla, devuelve `failed` y el llamador
 * conserva el borrador tal cual — un error de red no puede borrar el pedido.
 */
export async function interpretMessage(
  messageText: string,
  known: OrderDraft,
  images: DownloadedImage[] = [],
): Promise<ExtractionOutcome> {
  const prompt = `Hora actual: ${horaCali()}\n\nDatos ya capturados:\n${JSON.stringify(knownForModel(known))}\n\nMensaje nuevo del restaurante:\n${messageText || "(sin texto)"}`;
  // Las fotos van como parte del mensaje nuevo: una captura del pedido se lee
  // igual que si la hubieran escrito.
  const userContent = images.length
    ? [
        { type: "text", text: `${prompt}\n\n(El restaurante adjuntó ${images.length === 1 ? "una imagen" : `${images.length} imágenes`}: léela${images.length === 1 ? "" : "s"} como parte del mensaje.)` },
        ...images.map((img) => ({ type: "image_url", image_url: { url: `data:${img.mimeType};base64,${img.base64}`, detail: "high" } })),
      ]
    : prompt;
  const body = JSON.stringify({
    model: env.openai.chatModel,
    response_format: { type: "json_object" },
    temperature: 0,
    messages: [
      { role: "system", content: buildExtractionPrompt() },
      { role: "user", content: userContent },
    ],
  });

  const call = () =>
    fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${env.openai.apiKey}` },
      body,
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });

  try {
    let response: Response;
    try {
      response = await call();
      if (isTransient(response.status)) throw new Error(`HTTP ${response.status}`);
    } catch (error) {
      console.warn("[openai] falló, reintentando una vez:", error instanceof Error ? error.message : error);
      await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY_MS));
      response = await call();
    }

    if (!response.ok) {
      console.error(`[openai] error ${response.status}: ${(await response.text()).slice(0, 200)}`);
      return { fields: NOTHING, query: null, intent: null, confirms: false, confused: false, failed: true };
    }

    const data = (await response.json()) as { choices?: { message?: { content?: string } }[] };
    const raw = JSON.parse(data.choices?.[0]?.message?.content ?? "{}");

    const entregas = Array.isArray(raw.entregas)
      ? raw.entregas.filter((e: unknown): e is Record<string, unknown> => !!e && typeof e === "object").map(parseDelivery)
      : [];

    for (const e of entregas) {
      const real = e.dudas?.filter((k: DoubtfulField) => e[k] != null) ?? [];
      e.dudas = real.length ? real : null;
    }

    return {
      fields: {
        origenRestaurante: text(raw.origenRestaurante),
        nombreRestaurante: text(raw.nombreRestaurante),
        entregas,
        quitar: Array.isArray(raw.quitar) ? raw.quitar.filter((n: unknown): n is number => Number.isInteger(n)) : [],
      },
      query: raw.consulta === "estado" || raw.consulta === "cobertura" ? raw.consulta : null,
      intent: raw.intencion === "cotizar" || raw.intencion === "pedir" ? raw.intencion : null,
      confirms: raw.confirma === true,
      confused: raw.confuso === true,
      failed: false,
    };
  } catch (error) {
    console.error("[openai] no se pudo extraer el pedido:", error instanceof Error ? error.message : error);
    return { fields: NOTHING, query: null, intent: null, confirms: false, confused: false, failed: true };
  }
}

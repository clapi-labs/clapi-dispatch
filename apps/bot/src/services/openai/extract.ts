import { buildExtractionPrompt, type Interpretation, type OrderDraft } from "@dispatch/shared";

import { env } from "@/env";

/** `confirms`: el restaurante aceptó el servicio cotizado (lo dice el modelo;
 *  el código igual verifica que haya una cotización que aceptar). */
/** `query`: el mensaje pregunta algo en vez de pedir (docs/BOT.md, consultas). */
export type ExtractionOutcome = { fields: Interpretation; query: "estado" | "cobertura" | null; confirms: boolean; confused: boolean; failed: boolean };

const NOTHING: Interpretation = { origenRestaurante: null, zonaRecogida: null, entregas: [] };

const text = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : null);

/** Lo que el modelo necesita saber del pedido en curso: los datos y la etapa,
 *  sin coordenadas ni ids internos. */
function knownForModel(known: OrderDraft) {
  return {
    etapa: known.etapa,
    origenRestaurante: known.origenRestaurante,
    entregas: known.entregas.map(({ direccionEntrega, telefonoCliente, nombreCliente, valorACobrar, metodoPago, listoEnMinutos, notas }) => ({
      direccionEntrega,
      telefonoCliente,
      nombreCliente,
      valorACobrar,
      metodoPago,
      listoEnMinutos,
      notas,
    })),
  };
}

/** Una entrega tal como la devolvió el modelo, validada campo por campo. */
function parseDelivery(raw: Record<string, unknown>): Interpretation["entregas"][number] {
  const valor =
    typeof raw.valorACobrar === "number"
      ? raw.valorACobrar
      : typeof raw.valorACobrar === "string" && /\d/.test(raw.valorACobrar)
        ? Number(raw.valorACobrar.replace(/\D/g, ""))
        : null;
  const listo = typeof raw.listoEnMinutos === "number" ? Math.round(raw.listoEnMinutos) : null;
  const phone = typeof raw.telefonoCliente === "string" ? raw.telefonoCliente.replace(/\D/g, "") : "";
  return {
    direccionEntrega: text(raw.direccionEntrega),
    telefonoCliente: phone.length >= 7 ? phone : null,
    nombreCliente: text(raw.nombreCliente),
    valorACobrar: valor && valor > 0 ? valor : null,
    metodoPago: raw.metodoPago === "efectivo" || raw.metodoPago === "transferencia" ? raw.metodoPago : null,
    listoEnMinutos: listo !== null && listo >= 0 && listo <= MAX_LISTO_MIN ? listo : null,
    notas: text(raw.notas),
    zonaEntrega: text(raw.zonaEntrega),
  };
}

const TIMEOUT_MS = 15_000;
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
  zoneNames: string[],
): Promise<ExtractionOutcome> {
  const body = JSON.stringify({
    model: env.openai.chatModel,
    response_format: { type: "json_object" },
    temperature: 0,
    messages: [
      { role: "system", content: buildExtractionPrompt(zoneNames) },
      {
        role: "user",
        content: `Hora actual: ${horaCali()}\n\nDatos ya capturados:\n${JSON.stringify(knownForModel(known))}\n\nMensaje nuevo del restaurante:\n${messageText}`,
      },
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
      return { fields: NOTHING, query: null, confirms: false, confused: false, failed: true };
    }

    const data = (await response.json()) as { choices?: { message?: { content?: string } }[] };
    const raw = JSON.parse(data.choices?.[0]?.message?.content ?? "{}");

    const entregas = Array.isArray(raw.entregas)
      ? raw.entregas.filter((e: unknown): e is Record<string, unknown> => !!e && typeof e === "object").map(parseDelivery)
      : [];

    return {
      fields: { origenRestaurante: text(raw.origenRestaurante), zonaRecogida: text(raw.zonaRecogida), entregas },
      query: raw.consulta === "estado" || raw.consulta === "cobertura" ? raw.consulta : null,
      confirms: raw.confirma === true,
      confused: raw.confuso === true,
      failed: false,
    };
  } catch (error) {
    console.error("[openai] no se pudo extraer el pedido:", error instanceof Error ? error.message : error);
    return { fields: NOTHING, query: null, confirms: false, confused: false, failed: true };
  }
}

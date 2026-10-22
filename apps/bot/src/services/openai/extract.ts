import { EMPTY_TRIP_FIELDS, buildExtractionPrompt, type ExtractedTripFields } from "@dispatch/shared";

import { env } from "@/env";

export type ExtractionOutcome = { fields: ExtractedTripFields; confused: boolean; failed: boolean };

const TIMEOUT_MS = 15_000;
const RETRY_DELAY_MS = 800;

/** Fallos que valen un segundo intento: red, tiempo agotado, 429 y 5xx. Un 4xx
 *  (llave mala, petición inválida) se repetiría igual. */
function isTransient(status: number) {
  return status === 429 || status >= 500;
}

/**
 * Una sola llamada con salida JSON forzada. Recibe lo ya capturado para que
 * el modelo sepa a qué campo pertenece un dato suelto ("3001234567" → el
 * teléfono que faltaba). Si OpenAI falla, devuelve `failed` y el llamador
 * conserva el borrador tal cual — un error de red no puede borrar el pedido.
 */
export async function extractTripFields(
  messageText: string,
  known: ExtractedTripFields,
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
        content: `Datos ya capturados:\n${JSON.stringify(known)}\n\nMensaje nuevo del restaurante:\n${messageText}`,
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
      return { fields: EMPTY_TRIP_FIELDS, confused: false, failed: true };
    }

    const data = (await response.json()) as { choices?: { message?: { content?: string } }[] };
    const raw = JSON.parse(data.choices?.[0]?.message?.content ?? "{}");

    const valor =
      typeof raw.valorACobrar === "number"
        ? raw.valorACobrar
        : typeof raw.valorACobrar === "string" && /\d/.test(raw.valorACobrar)
          ? Number(raw.valorACobrar.replace(/\D/g, ""))
          : null;

    return {
      fields: {
        origenRestaurante: typeof raw.origenRestaurante === "string" && raw.origenRestaurante.trim() ? raw.origenRestaurante.trim() : null,
        direccionEntrega: typeof raw.direccionEntrega === "string" && raw.direccionEntrega.trim() ? raw.direccionEntrega.trim() : null,
        telefonoCliente: typeof raw.telefonoCliente === "string" && /\d{7,}/.test(raw.telefonoCliente.replace(/\D/g, "")) ? raw.telefonoCliente.replace(/\D/g, "") : null,
        valorACobrar: valor && valor > 0 ? valor : null,
        metodoPago: raw.metodoPago === "efectivo" || raw.metodoPago === "transferencia" ? raw.metodoPago : null,
        zonaRecogida: typeof raw.zonaRecogida === "string" ? raw.zonaRecogida : null,
        zonaEntrega: typeof raw.zonaEntrega === "string" ? raw.zonaEntrega : null,
      },
      confused: raw.confuso === true,
      failed: false,
    };
  } catch (error) {
    console.error("[openai] no se pudo extraer el pedido:", error instanceof Error ? error.message : error);
    return { fields: EMPTY_TRIP_FIELDS, confused: false, failed: true };
  }
}

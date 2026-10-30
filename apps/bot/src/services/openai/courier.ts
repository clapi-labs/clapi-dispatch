import { env } from "@/env";

/**
 * Qué quiere decir un mensaje escrito del motorizado. Lo normal es que no
 * escriba nada (la ficha y el botón bastan); cuando escribe, casi siempre es
 * un «ok» o «voy» que no necesita respuesta. Lo que importa es no dejar pasar
 * una novedad: un accidente, que no puede ir, que cancela.
 *
 * - `novedad`: algo impide o pone en riesgo el servicio → la central decide.
 * - `ficha`: pide los datos del viaje otra vez (dirección, teléfono…).
 * - `otro`: saludo, «ok», «voy en camino», «listo»… → no se responde.
 */
export type CourierIntent = { kind: "novedad" | "ficha" | "otro"; summary: string | null };

const PROMPT = `Eres la central de una agencia de domicilios en Cali. Un motorizado de la flota te escribe por WhatsApp. Clasifica su mensaje y devuelve SOLO este JSON:

{ "tipo": "novedad" | "ficha" | "otro", "resumen": string | null }

- "novedad": algo impide o pone en riesgo un servicio, o necesita que la central intervenga: accidente, se varó o pinchó, lo robaron, no puede ir, cancela, el cliente no contesta o no baja, la dirección no existe, el restaurante no entrega el pedido o lo hace esperar mucho, el pedido se dañó, pide hablar con alguien. "resumen": una frase corta para la central ("Se accidentó", "El cliente no contesta").
- "ficha": pide que le repitan los datos del viaje (dirección, teléfono, a dónde va, "mándame la ficha"). "resumen": null.
- "otro": saludos, "ok", "listo", "voy", "ya llegué", "ya recogí", "gracias", "me conecto". "resumen": null.
- Ante la duda entre "novedad" y "otro", elige "novedad": es mejor que la central mire de más a que se le pase un problema.`;

/** Si OpenAI falla, el mensaje se trata como novedad: que lo vea una persona. */
export async function classifyCourierMessage(text: string): Promise<CourierIntent> {
  try {
    const response = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${env.openai.apiKey}` },
      body: JSON.stringify({
        model: env.openai.chatModel,
        response_format: { type: "json_object" },
        temperature: 0,
        messages: [
          { role: "system", content: PROMPT },
          { role: "user", content: text },
        ],
      }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const data = (await response.json()) as { choices?: { message?: { content?: string } }[] };
    const raw = JSON.parse(data.choices?.[0]?.message?.content ?? "{}");
    const kind = raw.tipo === "ficha" || raw.tipo === "otro" ? raw.tipo : "novedad";
    const summary = typeof raw.resumen === "string" && raw.resumen.trim() ? raw.resumen.trim() : null;
    return { kind, summary };
  } catch (error) {
    console.error("[openai] no se pudo clasificar el mensaje del motorizado:", error instanceof Error ? error.message : error);
    return { kind: "novedad", summary: "No se pudo leer su mensaje" };
  }
}

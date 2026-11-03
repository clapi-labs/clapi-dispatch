import { after } from "next/server";

import { handleIncoming } from "@/bot/intake";
import { markProcessedIfNew } from "@/db/queries/idempotency";
import { env } from "@/env";
import { extractIncomingMessages } from "@/services/whatsapp/normalize";
import type { WaWebhookPayload } from "@/services/whatsapp/types";
import { handleVerification, isValidSignature } from "@/services/whatsapp/verify";

export const dynamic = "force-dynamic";

/** Apretón de manos al configurar el webhook en el panel de Meta. */
export async function GET(request: Request) {
  const result = handleVerification(new URL(request.url), env.whatsapp.verifyToken);

  if (!result.ok) {
    return new Response("Forbidden", { status: 403 });
  }

  return new Response(result.challenge, { status: 200, headers: { "Content-Type": "text/plain" } });
}

/**
 * Mismas dos reglas que CLAPI: se acusa 200 siempre (un 500 solo logra que
 * Meta reintente, no que procese mejor) y todo pasa por `processed_messages`
 * antes de hacer nada. El acuse sale antes de procesar, con `after()`.
 */
export async function POST(request: Request) {
  const rawBody = await request.text();

  if (!isValidSignature(rawBody, request.headers.get("x-hub-signature-256"), env.whatsapp.appSecret)) {
    return new Response("Invalid signature", { status: 403 });
  }

  let payload: WaWebhookPayload;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    return new Response("OK", { status: 200 });
  }

  after(async () => {
    try {
      await processWebhook(payload);
    } catch (error) {
      console.error("[webhook] fallo procesando la entrega:", error);
    }
  });

  return new Response("OK", { status: 200 });
}

/**
 * Los mensajes de una misma entrega se atienden a la vez: el bot espera unos
 * segundos antes de responder (`REPLY_DELAY_MS`) para juntar los que llegan
 * seguidos, y uno tras otro cada mensaje esperaría solo.
 */
async function processWebhook(payload: WaWebhookPayload) {
  const fresh = [];
  for (const message of extractIncomingMessages(payload)) {
    if (await markProcessedIfNew(message.waMessageId)) fresh.push(message);
  }

  await Promise.all(
    fresh.map((message) =>
      handleIncoming(message).catch((error) => console.error("[webhook] fallo procesando un mensaje:", error)),
    ),
  );
}

import { eq } from "drizzle-orm";

import { db, schema } from "@dispatch/shared/db";
import { mediaConfig } from "@dispatch/shared/media";

import { serveMedia } from "@/lib/media-serve";

export const dynamic = "force-dynamic";

/**
 * La foto de un mensaje del chat, por el id del mensaje. Solo con sesión (el
 * `proxy.ts` pide login a toda `/api/*`). Los archivos viven en el volumen de
 * fotos del servidor, que el bot llena y limpia.
 */
export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const messageId = Number(id);
  if (!Number.isSafeInteger(messageId) || messageId <= 0) return serveMedia(null, "");

  const [ref] = await db
    .select({ mediaPath: schema.messages.mediaPath, mediaMime: schema.messages.mediaMime, mediaStatus: schema.messages.mediaStatus })
    .from(schema.messages)
    .where(eq(schema.messages.id, messageId))
    .limit(1);
  return serveMedia(ref, mediaConfig().dir);
}

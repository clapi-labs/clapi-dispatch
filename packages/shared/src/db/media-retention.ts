import { and, eq, inArray, isNotNull } from "drizzle-orm";

import { mediaConfig, purgeMedia, type MediaIndex, type PurgeResult } from "../media";
import { db } from "./client";
import { messages } from "./schema";

/**
 * La limpieza de las fotos contra la base: lista las que siguen en disco y
 * marca como `expired` las que se borraron. La decisión y el borrado de
 * archivos están en `../media/purge.ts`.
 */
export const mediaIndex: MediaIndex = {
  async listStored() {
    const rows = await db
      .select({ id: messages.id, path: messages.mediaPath, bytes: messages.mediaBytes, createdAt: messages.createdAt })
      .from(messages)
      .where(and(eq(messages.mediaStatus, "stored"), isNotNull(messages.mediaPath)));
    return rows.map((r) => ({ id: r.id, path: r.path!, bytes: r.bytes ?? 0, createdAt: r.createdAt }));
  },

  async markExpired(ids, reason, at) {
    if (ids.length === 0) return;
    await db
      .update(messages)
      .set({ mediaStatus: "expired", mediaExpiredReason: reason, mediaExpiredAt: at })
      .where(and(inArray(messages.id, ids), eq(messages.mediaStatus, "stored")));
  },
};

/** Borra las fotos viejas y, si hace falta, las más antiguas hasta bajar de los topes. */
export function purgeOldMedia(now = new Date()): Promise<PurgeResult> {
  return purgeMedia({ index: mediaIndex, config: mediaConfig(), now });
}

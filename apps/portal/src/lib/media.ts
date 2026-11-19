import type { ChatMedia } from "@/lib/types";

/**
 * La foto de un mensaje del chat. En la base solo hay la referencia al archivo
 * (`messages.media_*`); aquí se convierte en lo que muestra el portal.
 */

/** Las columnas de la foto, como salen de `messages`. */
export type MediaColumns = {
  mediaStatus: "stored" | "expired" | null;
  mediaMime: string | null;
  mediaBytes: number | null;
  mediaWidth: number | null;
  mediaHeight: number | null;
  mediaExpiredReason: "ttl" | "space" | null;
};

/** `null` si el mensaje no trae foto. `retentionDays` es el plazo vigente, para el texto de «expirada». */
export function mediaOf(row: MediaColumns, retentionDays: number): ChatMedia | null {
  if (row.mediaStatus === "stored") {
    return { status: "stored", mime: row.mediaMime ?? "image/webp", width: row.mediaWidth, height: row.mediaHeight, bytes: row.mediaBytes ?? 0 };
  }
  if (row.mediaStatus === "expired") return { status: "expired", reason: row.mediaExpiredReason, retentionDays };
  return null;
}

/** De dónde se pide la foto al servidor (autenticado: solo con sesión). */
export const mediaUrl = (messageId: number) => `/api/media/${messageId}`;

/** El pie de foto: el texto del mensaje sin la etiqueta `[Imagen]` con que el bot lo anota. */
export function captionOf(text: string): string {
  return text.replace(/^\[Imagen\]\s*/, "").trim();
}

/** Lo que se ve en lugar de una foto que ya no está. */
export function placeholderText(media: ChatMedia | null): string {
  if (media?.status === "expired") {
    if (media.reason === "ttl") {
      return `Imagen expirada (eliminada tras ${media.retentionDays} ${media.retentionDays === 1 ? "día" : "días"})`;
    }
    if (media.reason === "space") return "Imagen eliminada para liberar espacio";
    return "Imagen expirada";
  }
  return "Imagen no disponible";
}

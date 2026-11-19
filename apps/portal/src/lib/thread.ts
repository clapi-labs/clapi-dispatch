import type { ChatMessage } from "./types";

/**
 * El hilo que tiene la pantalla, armado por páginas (H2 en
 * docs/CAPACIDAD-CONVERSACIONES.md): se abre con los últimos mensajes, se
 * agregan los anteriores con «Cargar anteriores» y se pone al día pidiendo solo
 * desde el final.
 */

/** Cuántos mensajes trae el hilo al abrirlo y cada «Cargar anteriores». */
export const THREAD_PAGE = 50;

/** Lo que responde `GET /api/conversations/:id?limit=|before=|after=`
 *  (`getThreadPage` en db/queries/conversations.ts). */
export type ThreadPage = {
  messages: ChatMessage[];
  /** Si hay mensajes más viejos que el primero de la página. `null` con
   *  `after`: esa consulta no lo mira, se queda lo que ya se sabía. */
  hasOlder: boolean | null;
  /** Con `after` había demasiados nuevos: es la última página entera y
   *  reemplaza lo que se tenía. */
  reset: boolean;
};

/** Cuántos de los últimos mensajes se vuelven a pedir al ponerse al día: así
 *  se ve también un mensaje reciente que cambió (el «No se pudo entregar» que
 *  Meta avisa después). */
export const REFRESH_OVERLAP = 20;

/** Desde qué id pedir al ponerse al día (`?after=`). */
export function refreshAfter(thread: readonly ChatMessage[]): number {
  if (thread.length === 0) return 0;
  return thread[Math.max(0, thread.length - REFRESH_OVERLAP)].id - 1;
}

function same(a: ChatMessage, b: ChatMessage): boolean {
  return (
    a.text === b.text &&
    a.role === b.role &&
    a.createdAt === b.createdAt &&
    (a.quote?.id ?? null) === (b.quote?.id ?? null) &&
    (a.quote?.text ?? null) === (b.quote?.text ?? null) &&
    (a.tripCodes ?? []).join(",") === (b.tripCodes ?? []).join(",")
  );
}

/**
 * Junta lo que llegó con lo que se tenía: reemplaza los mensajes que cambiaron,
 * agrega los nuevos y deja todo en orden por id. Si no cambió nada devuelve el
 * mismo arreglo, para que React no vuelva a pintar el hilo.
 */
export function mergeThread(current: readonly ChatMessage[], incoming: readonly ChatMessage[]): ChatMessage[] {
  if (incoming.length === 0) return current as ChatMessage[];
  const byId = new Map(current.map((m, i) => [m.id, i]));
  let changed = false;
  const next = [...current];
  const added: ChatMessage[] = [];
  for (const m of incoming) {
    const at = byId.get(m.id);
    if (at === undefined) {
      added.push(m);
      changed = true;
    } else if (!same(next[at], m)) {
      next[at] = m;
      changed = true;
    }
  }
  if (!changed) return current as ChatMessage[];
  if (added.length === 0) return next;
  return [...next, ...added].sort((a, b) => a.id - b.id);
}

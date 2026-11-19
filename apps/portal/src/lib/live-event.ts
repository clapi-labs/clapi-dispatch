/**
 * Un aviso de /api/events tal como lo manda Postgres (canal "dispatch_changes"):
 * el nombre de la tabla y, para `messages`, los chats que cambiaron
 * ("messages:12,15", migración 0026). Sin ids (un aviso de otra tabla, un
 * borrado o demasiados chats a la vez) puede ser cualquiera.
 */
export type Change = { topic: string; ids: number[] | null };

export function parseChange(data: string): Change {
  const colon = data.indexOf(":");
  if (colon === -1) return { topic: data, ids: null };
  const ids = data
    .slice(colon + 1)
    .split(",")
    .map((s) => Number(s))
    .filter((n) => Number.isInteger(n) && n > 0);
  return { topic: data.slice(0, colon), ids: ids.length > 0 ? ids : null };
}

/** Si un aviso toca el chat `id`: sí cuando no dice cuáles. */
export function touches(change: Change, id: number): boolean {
  return change.ids === null || change.ids.includes(id);
}

import path from "node:path";

/** `AAAA-MM-DD` (UTC) de un instante: la carpeta de las fotos de ese día. */
export function dayFolder(at: Date): string {
  return at.toISOString().slice(0, 10);
}

const DAY_FOLDER = /^\d{4}-\d{2}-\d{2}$/;
export const isDayFolder = (name: string) => DAY_FOLDER.test(name);

/** La ruta relativa con que se guarda una foto: `AAAA-MM-DD/<id>.<ext>`. */
export function relativeMediaPath(at: Date, id: string, ext: string): string {
  return `${dayFolder(at)}/${id}.${ext}`;
}

/**
 * La ruta absoluta de una foto, o `null` si la ruta guardada intenta salirse de
 * la carpeta de fotos (`..`, una ruta absoluta, una letra de unidad). Lo único
 * que se sirve al navegador sale de aquí.
 */
export function resolveMediaPath(dir: string, relative: string): string | null {
  if (!relative || relative.includes("\0") || path.isAbsolute(relative) || /^[a-zA-Z]:/.test(relative)) return null;
  const root = path.resolve(dir);
  const full = path.resolve(root, relative);
  return full.startsWith(root + path.sep) ? full : null;
}

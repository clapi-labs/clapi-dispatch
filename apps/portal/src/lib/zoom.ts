/**
 * El zoom del visor de fotos. El portal bloquea el zoom de la página
 * (`userScalable: false`), así que el visor trae el suyo: rueda del ratón,
 * pellizco, doble toque y botones. Aquí está solo la cuenta, sin DOM.
 *
 * La foto se pinta a su tamaño «ajustado» a la caja (`fitSize`) y se
 * transforma con `translate(x, y) scale(s)` desde su centro. `x` e `y` son el
 * desplazamiento del centro de la foto respecto al centro de la caja.
 */

export const MIN_SCALE = 1;
export const MAX_SCALE = 6;
/** A cuánto salta el doble toque. */
export const DOUBLE_TAP_SCALE = 2.5;

export type Size = { w: number; h: number };
export type View = { scale: number; x: number; y: number };
export const FIT: View = { scale: MIN_SCALE, x: 0, y: 0 };

export function clampScale(scale: number): number {
  if (!Number.isFinite(scale)) return MIN_SCALE;
  return Math.min(MAX_SCALE, Math.max(MIN_SCALE, scale));
}

/** El tamaño de la foto ajustada a la caja, sin deformarla ni agrandarla más de lo natural. */
export function fitSize(box: Size, natural: Size): Size {
  if (natural.w <= 0 || natural.h <= 0 || box.w <= 0 || box.h <= 0) return { w: 0, h: 0 };
  const ratio = Math.min(box.w / natural.w, box.h / natural.h, 1);
  return { w: natural.w * ratio, h: natural.h * ratio };
}

/** Que la foto no se pueda arrastrar hasta dejar la caja vacía: solo hasta que su borde toque el de la caja. */
export function clampView(view: View, box: Size, fitted: Size): View {
  const scale = clampScale(view.scale);
  const limitX = Math.max(0, (fitted.w * scale - box.w) / 2);
  const limitY = Math.max(0, (fitted.h * scale - box.h) / 2);
  // `+ 0`: sin él, un límite de 0 puede dar -0.
  return { scale, x: Math.min(limitX, Math.max(-limitX, view.x)) + 0, y: Math.min(limitY, Math.max(-limitY, view.y)) + 0 };
}

/**
 * Cambia la escala dejando quieto el punto de la foto que está bajo `point`
 * (relativo al centro de la caja): al acercar con la rueda, la foto crece
 * desde el cursor y no desde el centro.
 */
export function zoomAt(view: View, nextScale: number, point: { x: number; y: number }, box: Size, fitted: Size): View {
  const scale = clampScale(nextScale);
  const ratio = scale / view.scale;
  return clampView({ scale, x: point.x - (point.x - view.x) * ratio, y: point.y - (point.y - view.y) * ratio }, box, fitted);
}

/** Doble toque: si está en su tamaño, acerca ahí; si ya está acercada, vuelve a ajustar. */
export function toggleZoom(view: View, point: { x: number; y: number }, box: Size, fitted: Size): View {
  return view.scale > MIN_SCALE + 0.01 ? FIT : zoomAt(view, DOUBLE_TAP_SCALE, point, box, fitted);
}

export const distance = (a: { x: number; y: number }, b: { x: number; y: number }) => Math.hypot(a.x - b.x, a.y - b.y);

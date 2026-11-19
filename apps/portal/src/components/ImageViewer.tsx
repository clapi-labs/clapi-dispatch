"use client";

import { Maximize2, Minus, Plus, X } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

import { clampView, distance, fitSize, FIT, MAX_SCALE, MIN_SCALE, toggleZoom, zoomAt, type Size, type View } from "@/lib/zoom";

type Point = { x: number; y: number };

/**
 * La foto de un chat a pantalla completa, con zoom propio: el portal bloquea el
 * zoom de la página, así que acá va el suyo. Con el ratón: rueda para acercar,
 * arrastrar para mover y doble clic para alternar. Con el dedo: pellizco, arrastre
 * y doble toque. Teclado: Esc cierra, + y − acercan, 0 ajusta. La cuenta está
 * en `lib/zoom.ts`.
 */
export function ImageViewer({
  src,
  caption,
  width,
  height,
  onClose,
}: {
  src: string;
  caption?: string;
  /** El tamaño de la foto, si se sabe: así se ajusta antes de que cargue. */
  width?: number | null;
  height?: number | null;
  onClose: () => void;
}) {
  const stage = useRef<HTMLDivElement>(null);
  const [box, setBox] = useState<Size>({ w: 0, h: 0 });
  const [natural, setNatural] = useState<Size>({ w: width ?? 0, h: height ?? 0 });
  const [view, setView] = useState<View>(FIT);
  const [gesturing, setGesturing] = useState(false);
  const [failed, setFailed] = useState(false);

  const fitted = fitSize(box, natural);
  // Las funciones de los eventos leen siempre lo último sin volver a registrarse.
  const latest = useRef({ view, box, fitted });
  useEffect(() => {
    latest.current = { view, box, fitted };
  });

  useEffect(() => {
    const el = stage.current;
    if (!el) return;
    const measure = () => setBox({ w: el.clientWidth, h: el.clientHeight });
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  /** Un punto de pantalla, relativo al centro de la caja. */
  const centered = useCallback((clientX: number, clientY: number): Point => {
    const rect = stage.current!.getBoundingClientRect();
    return { x: clientX - rect.left - rect.width / 2, y: clientY - rect.top - rect.height / 2 };
  }, []);

  const zoomBy = useCallback((factor: number, point: Point = { x: 0, y: 0 }) => {
    const { view: v, box: b, fitted: f } = latest.current;
    setView(zoomAt(v, v.scale * factor, point, b, f));
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
      else if (e.key === "+" || e.key === "=") zoomBy(1.5);
      else if (e.key === "-" || e.key === "_") zoomBy(1 / 1.5);
      else if (e.key === "0") setView(FIT);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose, zoomBy]);

  // La rueda: se registra a mano porque React la deja pasiva y acá hay que frenar el scroll de atrás.
  useEffect(() => {
    const el = stage.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      // En el trackpad, el pellizco llega como rueda con Ctrl y valores chicos.
      zoomBy(Math.exp(-e.deltaY * (e.ctrlKey ? 0.01 : 0.0015)), centered(e.clientX, e.clientY));
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [centered, zoomBy]);

  // Gestos: un dedo arrastra (si hay zoom), dos pellizcan; un toque rápido dos veces alterna el zoom.
  const pointers = useRef(new Map<number, Point>());
  const pan = useRef<{ from: Point; view: View } | null>(null);
  const pinch = useRef<{ dist: number; mid: Point; view: View } | null>(null);
  const tap = useRef<{ at: number; point: Point; moved: boolean; last: number; lastPoint: Point }>({ at: 0, point: { x: 0, y: 0 }, moved: false, last: 0, lastPoint: { x: 0, y: 0 } });

  const beginPinch = () => {
    const [a, b] = [...pointers.current.values()];
    pinch.current = { dist: Math.max(1, distance(a, b)), mid: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }, view: latest.current.view };
    pan.current = null;
  };

  function onPointerDown(e: React.PointerEvent) {
    e.currentTarget.setPointerCapture(e.pointerId);
    const point = centered(e.clientX, e.clientY);
    pointers.current.set(e.pointerId, point);
    setGesturing(true);
    if (pointers.current.size === 2) beginPinch();
    else {
      pan.current = { from: point, view: latest.current.view };
      tap.current = { ...tap.current, at: Date.now(), point, moved: false };
    }
  }

  function onPointerMove(e: React.PointerEvent) {
    if (!pointers.current.has(e.pointerId)) return;
    const point = centered(e.clientX, e.clientY);
    pointers.current.set(e.pointerId, point);
    const { box: b, fitted: f } = latest.current;

    if (pinch.current && pointers.current.size >= 2) {
      const [p1, p2] = [...pointers.current.values()];
      const mid = { x: (p1.x + p2.x) / 2, y: (p1.y + p2.y) / 2 };
      const start = pinch.current;
      const zoomed = zoomAt(start.view, start.view.scale * (distance(p1, p2) / start.dist), start.mid, b, f);
      setView(clampView({ ...zoomed, x: zoomed.x + (mid.x - start.mid.x), y: zoomed.y + (mid.y - start.mid.y) }, b, f));
      tap.current.moved = true;
    } else if (pan.current) {
      const dx = point.x - pan.current.from.x;
      const dy = point.y - pan.current.from.y;
      if (Math.hypot(dx, dy) > 8) tap.current.moved = true;
      if (pan.current.view.scale > MIN_SCALE) setView(clampView({ ...pan.current.view, x: pan.current.view.x + dx, y: pan.current.view.y + dy }, b, f));
    }
  }

  function onPointerUp(e: React.PointerEvent) {
    const point = pointers.current.get(e.pointerId);
    pointers.current.delete(e.pointerId);
    if (pointers.current.size === 0) setGesturing(false);

    if (pointers.current.size === 1) {
      // Soltó uno de los dos dedos: el que queda sigue arrastrando desde donde está.
      const [rest] = [...pointers.current.values()];
      pan.current = { from: rest, view: latest.current.view };
      pinch.current = null;
      return;
    }
    pinch.current = null;
    pan.current = null;
    if (!point || e.type === "pointercancel" || tap.current.moved || Date.now() - tap.current.at > 300) return;

    // Un toque. Dos seguidos, cerca uno del otro: doble toque.
    const now = Date.now();
    const { box: b, fitted: f, view: v } = latest.current;
    if (now - tap.current.last < 320 && distance(point, tap.current.lastPoint) < 30) {
      tap.current.last = 0;
      setView(toggleZoom(v, point, b, f));
      return;
    }
    tap.current.last = now;
    tap.current.lastPoint = point;
    // Un toque fuera de la foto cierra (como tocar el fondo).
    const halfW = (f.w * v.scale) / 2;
    const halfH = (f.h * v.scale) / 2;
    const outside = Math.abs(point.x - v.x) > halfW || Math.abs(point.y - v.y) > halfH;
    if (outside) onClose();
  }

  const percent = Math.round(view.scale * 100);

  return createPortal(
    <div role="dialog" aria-modal="true" aria-label="Imagen del chat" className="fixed inset-0 z-60 bg-black/90 text-white">
      <div
        ref={stage}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        className={`absolute inset-0 flex touch-none select-none items-center justify-center overflow-hidden ${view.scale > MIN_SCALE ? "cursor-grab active:cursor-grabbing" : "cursor-zoom-in"}`}
      >
        {failed ? (
          <p className="rounded-xl bg-white/10 px-4 py-3 text-sm">Imagen no disponible</p>
        ) : (
          // eslint-disable-next-line @next/next/no-img-element -- la foto sale de un endpoint autenticado y ya viene achicada
          <img
            src={src}
            alt={caption || "Imagen del chat"}
            draggable={false}
            onLoad={(e) => setNatural({ w: e.currentTarget.naturalWidth, h: e.currentTarget.naturalHeight })}
            onError={() => setFailed(true)}
            style={{
              width: fitted.w || undefined,
              height: fitted.h || undefined,
              maxWidth: "100%",
              maxHeight: "100%",
              transform: `translate(${view.x}px, ${view.y}px) scale(${view.scale})`,
              transition: gesturing ? "none" : "transform 140ms ease-out",
            }}
            className="pointer-events-none max-w-none select-none object-contain"
          />
        )}
      </div>

      {caption && (
        <p className="pointer-events-none absolute inset-x-0 bottom-0 bg-linear-to-t from-black/70 to-transparent px-4 pb-[calc(4.5rem+env(safe-area-inset-bottom))] pt-10 text-center text-sm">
          {caption}
        </p>
      )}

      <button type="button" onClick={onClose} aria-label="Cerrar" className="absolute right-3 top-[calc(0.75rem+env(safe-area-inset-top))] flex h-10 w-10 items-center justify-center rounded-full bg-black/50 hover:bg-black/70">
        <X size={20} />
      </button>

      {!failed && (
        <div className="absolute bottom-[calc(1rem+env(safe-area-inset-bottom))] left-1/2 flex -translate-x-1/2 items-center gap-1 rounded-full bg-black/60 p-1 backdrop-blur">
          <button type="button" onClick={() => zoomBy(1 / 1.5)} disabled={view.scale <= MIN_SCALE} aria-label="Alejar" className="flex h-9 w-9 items-center justify-center rounded-full hover:bg-white/15 disabled:opacity-40">
            <Minus size={18} />
          </button>
          <button type="button" onClick={() => setView(FIT)} aria-label="Ajustar a la pantalla" className="flex h-9 min-w-14 items-center justify-center gap-1 rounded-full px-2 text-xs font-semibold tabular-nums hover:bg-white/15">
            {view.scale > MIN_SCALE ? `${percent} %` : <Maximize2 size={15} />}
          </button>
          <button type="button" onClick={() => zoomBy(1.5)} disabled={view.scale >= MAX_SCALE} aria-label="Acercar" className="flex h-9 w-9 items-center justify-center rounded-full hover:bg-white/15 disabled:opacity-40">
            <Plus size={18} />
          </button>
        </div>
      )}
    </div>,
    document.body,
  );
}

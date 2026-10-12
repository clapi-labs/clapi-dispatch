"use client";

import { Copy, Phone } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { isMobileDevice } from "@/lib/device";
import { formatPhone, phoneDigits } from "@/lib/format";

const BUTTON =
  "ease-ui flex h-9 min-w-9 shrink-0 items-center justify-center gap-1.5 rounded-lg bg-clapi-soft px-2.5 text-xs font-semibold text-clapi-ink active:bg-clapi active:text-white can-hover:hover:bg-clapi can-hover:hover:text-white";
const ITEM =
  "ease-ui flex h-10 w-full items-center gap-2.5 rounded-xl px-2.5 text-left text-sm font-medium text-ink can-hover:hover:bg-clapi-soft can-hover:hover:text-clapi-ink";

/**
 * Llamar desde el encabezado del chat. Es un enlace de verdad y el celular se
 * detecta al tocar, igual que en `PhoneLink`. En celular va directo a la app
 * de llamadas; en computador ofrece un menú: copiar el número o llamar con la
 * app del equipo.
 */
export function ChatContactActions({ phone, onCopy }: { phone: string; onCopy: (text: string) => void }) {
  const digits = phoneDigits(phone);
  const [callOpen, setCallOpen] = useState(false);
  const wrap = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!callOpen) return;
    const onDown = (e: PointerEvent) => {
      if (!wrap.current?.contains(e.target as Node)) setCallOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setCallOpen(false);
    };
    window.addEventListener("pointerdown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("pointerdown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [callOpen]);

  return (
    <div ref={wrap} className="relative shrink-0">
      <a
        href={`tel:+${digits}`}
        title="Llamar"
        aria-label="Llamar"
        onClick={(e) => {
          if (isMobileDevice()) return;
          e.preventDefault();
          setCallOpen((open) => !open);
        }}
        className={BUTTON}
      >
        <Phone size={15} />
        <span className="hidden xl:inline">Llamar</span>
      </a>
      {callOpen && (
        <div role="menu" aria-label="Llamar" className="absolute right-0 top-full z-30 mt-2 w-60 rounded-2xl bg-surface p-1.5 shadow-xl ring-1 ring-clapi-soft">
          <p className="px-2.5 pb-1 pt-1.5 text-xs font-semibold tabular-nums text-ink-3">{formatPhone(phone)}</p>
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              onCopy(`+${digits}`);
              setCallOpen(false);
            }}
            className={ITEM}
          >
            <Copy size={15} className="shrink-0 text-ink-3" /> Copiar número
          </button>
          <a role="menuitem" href={`tel:+${digits}`} onClick={() => setCallOpen(false)} className={ITEM}>
            <Phone size={15} className="shrink-0 text-ink-3" /> Llamar desde este equipo
          </a>
        </div>
      )}
    </div>
  );
}

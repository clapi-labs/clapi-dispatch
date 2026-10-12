"use client";

import { Zap } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { QUICK_REPLIES } from "@/lib/quick-replies";
import type { ConversationKind } from "@/lib/types";

/** El botón de respuestas rápidas del redactor: abre la lista de frases de la
 *  central y deja la elegida en la caja, lista para editar o enviar. */
export function QuickReplies({ kind, onPick }: { kind: ConversationKind; onPick: (text: string) => void }) {
  const [open, setOpen] = useState(false);
  const wrap = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      if (!wrap.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("pointerdown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("pointerdown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <div ref={wrap} className="relative shrink-0">
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-label="Respuestas rápidas"
        aria-haspopup="menu"
        aria-expanded={open}
        title="Respuestas rápidas"
        className={`ease-ui flex h-11 w-11 items-center justify-center rounded-xl ${
          open ? "bg-clapi text-white" : "bg-clapi-soft text-clapi-ink can-hover:hover:bg-clapi can-hover:hover:text-white"
        }`}
      >
        <Zap size={18} />
      </button>
      {open && (
        <div role="menu" aria-label="Respuestas rápidas" className="absolute bottom-full left-0 z-30 mb-2 w-72 max-w-[calc(100vw-1.5rem)] rounded-2xl bg-surface p-1.5 shadow-xl ring-1 ring-clapi-soft">
          <p className="px-2.5 pb-1 pt-1.5 text-xs font-semibold text-ink-3">Respuestas rápidas</p>
          {QUICK_REPLIES[kind].map((text) => (
            <button
              key={text}
              type="button"
              role="menuitem"
              onClick={() => {
                onPick(text);
                setOpen(false);
              }}
              className="ease-ui w-full rounded-xl px-2.5 py-2 text-left text-sm text-ink active:bg-clapi-soft can-hover:hover:bg-clapi-soft can-hover:hover:text-clapi-ink"
            >
              {text}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

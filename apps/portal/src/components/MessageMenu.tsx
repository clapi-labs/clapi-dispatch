"use client";

import { Copy, Forward, Phone } from "lucide-react";
import { motion } from "motion/react";
import { useEffect, useRef } from "react";
import { createPortal } from "react-dom";

import { findPhones, formatPhone } from "@/lib/format";
import type { ChatMessage } from "@/lib/types";

const ITEM =
  "ease-ui flex h-11 w-full items-center gap-3 rounded-xl px-3 text-left text-sm font-medium text-ink active:bg-clapi-soft can-hover:hover:bg-clapi-soft can-hover:hover:text-clapi-ink";
const WIDTH = 240;

/**
 * Las opciones de un mensaje: copiarlo, reenviarlo y, si el texto trae
 * teléfonos, copiarlos o llamarlos. Con `anchor` (computador) se abre pegado
 * al botón de los tres puntos; sin él (celular) sube como hoja desde abajo.
 * Va en un portal: el hilo recortaría lo que se saliera de su caja.
 */
export function MessageMenu({
  message,
  anchor,
  onCopy,
  onForward,
  onClose,
}: {
  message: ChatMessage;
  anchor: DOMRect | null;
  onCopy: (text: string, done: string) => void;
  onForward: () => void;
  onClose: () => void;
}) {
  const phones = findPhones(message.text).slice(0, 3);
  const panel = useRef<HTMLDivElement>(null);
  // Al mantener presionado, el dedo se levanta sobre el fondo recién pintado:
  // ese primer toque no puede cerrar la hoja.
  const armed = useRef(false);

  useEffect(() => {
    panel.current?.focus();
    const id = setTimeout(() => {
      armed.current = true;
    }, 350);
    return () => clearTimeout(id);
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const items = (
    <>
      <button
        type="button"
        role="menuitem"
        onClick={() => {
          onCopy(message.text, "Copiado al portapapeles");
          onClose();
        }}
        className={ITEM}
      >
        <Copy size={16} className="shrink-0 text-ink-3" /> Copiar texto
      </button>
      <button type="button" role="menuitem" onClick={onForward} className={ITEM}>
        <Forward size={16} className="shrink-0 text-ink-3" /> Reenviar
      </button>
      {phones.map((phone) => (
        <div key={phone} className="mt-1 border-t border-line pt-1">
          <p className="px-3 pb-0.5 pt-1.5 text-[11px] font-semibold tabular-nums text-ink-3">{formatPhone(phone)}</p>
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              onCopy(`+${phone}`, "Número copiado");
              onClose();
            }}
            className={ITEM}
          >
            <Copy size={16} className="shrink-0 text-ink-3" /> Copiar número
          </button>
          <a role="menuitem" href={`tel:+${phone}`} onClick={onClose} className={ITEM}>
            <Phone size={16} className="shrink-0 text-ink-3" /> Llamar
          </a>
        </div>
      ))}
    </>
  );

  if (anchor) {
    // Debajo del botón si cabe; si no, hacia arriba. Nunca fuera de la ventana.
    const height = 104 + phones.length * 124;
    const left = Math.min(Math.max(8, anchor.left), window.innerWidth - WIDTH - 8);
    const fits = anchor.bottom + 6 + height <= window.innerHeight;
    const place = fits ? { top: anchor.bottom + 6, left } : { bottom: window.innerHeight - anchor.top + 6, left };
    return createPortal(
      <div className="fixed inset-0 z-60" onClick={onClose}>
        <div
          ref={panel}
          role="menu"
          aria-label="Opciones del mensaje"
          tabIndex={-1}
          onClick={(e) => e.stopPropagation()}
          style={{ ...place, width: WIDTH }}
          className="fixed rounded-2xl bg-surface p-1.5 shadow-xl outline-none ring-1 ring-clapi-soft"
        >
          {items}
        </div>
      </div>,
      document.body,
    );
  }

  return createPortal(
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      transition={{ duration: 0.18 }}
      onClick={() => {
        if (armed.current) onClose();
      }}
      className="fixed inset-0 z-60 flex items-end justify-center bg-clapi-deep/45"
    >
      <motion.div
        ref={panel}
        role="menu"
        aria-label="Opciones del mensaje"
        tabIndex={-1}
        initial={{ y: "100%" }}
        animate={{ y: 0 }}
        transition={{ type: "spring", stiffness: 420, damping: 38 }}
        onClick={(e) => e.stopPropagation()}
        className="w-full max-w-md rounded-t-3xl bg-surface px-3 pb-[calc(env(safe-area-inset-bottom)+0.75rem)] pt-3 shadow-xl outline-none"
      >
        <span className="mx-auto mb-3 block h-1 w-9 rounded-full bg-line" />
        {/* El relleno va en la caja y el recorte en el texto: si no, la línea que sigue asoma por abajo. */}
        <div className="mb-2 rounded-xl bg-sunken px-3 py-2 text-xs text-ink-2">
          <p className="line-clamp-2 whitespace-pre-wrap wrap-anywhere">{message.text}</p>
        </div>
        {items}
        <button type="button" onClick={onClose} className="mt-1 h-12 w-full rounded-2xl text-sm font-semibold text-ink-3">
          Cancelar
        </button>
      </motion.div>
    </motion.div>,
    document.body,
  );
}

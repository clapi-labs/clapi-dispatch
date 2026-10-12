"use client";

import { MessageCircle, Phone } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

import { isMobileDevice } from "@/lib/device";
import { formatPhone, phoneDigits } from "@/lib/format";

/** El menú del celular: WhatsApp o llamada. Va en un portal porque las
 *  tarjetas se animan con `transform`, y eso encierra a un `fixed` adentro. */
function ContactSheet({ phone, name, onClose }: { phone: string; name?: string; onClose: () => void }) {
  const digits = phoneDigits(phone);
  const panel = useRef<HTMLDivElement>(null);

  useEffect(() => {
    panel.current?.focus();
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return createPortal(
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.18 }}
      onClick={onClose}
      className="fixed inset-0 z-60 flex items-end justify-center bg-clapi-deep/45"
    >
      <motion.div
        ref={panel}
        role="dialog"
        aria-modal="true"
        aria-label={`Contactar a ${name ?? formatPhone(phone)}`}
        tabIndex={-1}
        initial={{ y: "100%" }}
        animate={{ y: 0 }}
        exit={{ y: "100%" }}
        transition={{ type: "spring", stiffness: 420, damping: 38 }}
        onClick={(e) => e.stopPropagation()}
        className="w-full max-w-md rounded-t-3xl bg-surface px-4 pb-[calc(env(safe-area-inset-bottom)+0.75rem)] pt-3 shadow-xl outline-none"
      >
        <span className="mx-auto mb-4 block h-1 w-9 rounded-full bg-line" />
        <div className="mb-3 px-1 leading-tight">
          {name && <p className="truncate font-semibold">{name}</p>}
          <p className={name ? "text-sm text-ink-3" : "font-semibold"}>{formatPhone(phone)}</p>
        </div>

        <div className="flex flex-col gap-2">
          <a
            href={`https://wa.me/${digits}`}
            target="_blank"
            rel="noopener noreferrer"
            onClick={onClose}
            className="ease-ui flex h-14 items-center gap-3 rounded-2xl bg-sunken px-3 font-semibold text-ink active:bg-line"
          >
            <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-ok text-white">
              <MessageCircle size={18} />
            </span>
            Enviar WhatsApp
          </a>
          <a
            href={`tel:+${digits}`}
            onClick={onClose}
            className="ease-ui flex h-14 items-center gap-3 rounded-2xl bg-sunken px-3 font-semibold text-ink active:bg-line"
          >
            <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-clapi text-white">
              <Phone size={18} />
            </span>
            Llamar por teléfono
          </a>
        </div>

        <button type="button" onClick={onClose} className="mt-1 h-12 w-full rounded-2xl text-sm font-semibold text-ink-3">
          Cancelar
        </button>
      </motion.div>
    </motion.div>,
    document.body,
  );
}

/**
 * Un teléfono que se puede tocar. En computador abre el chat de ese número en
 * WhatsApp Web, en otra pestaña. En celular pregunta primero: WhatsApp o
 * llamada.
 *
 * Es un enlace de verdad y el celular se detecta al tocar, no al pintar: así
 * el servidor y el navegador renderizan lo mismo, y en computador sigue
 * sirviendo el clic del medio o "abrir en pestaña nueva".
 */
export function PhoneLink({
  phone,
  name,
  pill,
  className = "",
}: {
  phone: string;
  name?: string;
  /** Cápsula lavanda que se llena de violeta al pasar el cursor, en vez de un enlace de texto. */
  pill?: boolean;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const close = useCallback(() => setOpen(false), []);
  const look = pill
    ? "whitespace-nowrap rounded-full bg-clapi-soft px-2.5 py-1 text-[11px] font-semibold text-clapi-ink active:bg-clapi active:text-white can-hover:hover:bg-clapi can-hover:hover:text-white"
    : "underline-offset-2 decoration-clapi/40 can-hover:hover:text-clapi-ink can-hover:hover:underline";

  return (
    <>
      <a
        href={`https://web.whatsapp.com/send?phone=${phoneDigits(phone)}`}
        target="_blank"
        rel="noopener noreferrer"
        title="Escribir por WhatsApp"
        onClick={(e) => {
          if (!isMobileDevice()) return;
          e.preventDefault();
          setOpen(true);
        }}
        // El `after` agranda la zona que responde al dedo sin mover nada de sitio.
        className={`ease-ui relative inline-flex cursor-pointer items-center gap-1 after:absolute after:-inset-x-1 after:-inset-y-2 after:content-[''] ${look} ${className}`}
      >
        <Phone size={12} className="shrink-0" />
        {formatPhone(phone)}
      </a>
      <AnimatePresence>{open && <ContactSheet phone={phone} name={name} onClose={close} />}</AnimatePresence>
    </>
  );
}

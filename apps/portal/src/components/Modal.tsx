"use client";

import { useEffect, type ReactNode } from "react";
import { createPortal } from "react-dom";

/**
 * Ventana sobre la pantalla, con lo de atrás borroso. Va en un portal para que
 * ningún contenedor la recorte, y corta los clics: React los propaga por el
 * árbol de componentes, y una tarjeta que se abre al tocarla los recibiría.
 */
export function Modal({ label, onClose, children }: { label: string; onClose: () => void; children: ReactNode }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return createPortal(
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4 backdrop-blur-sm"
      onClick={(e) => {
        e.stopPropagation();
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div role="dialog" aria-modal="true" aria-label={label} className="flex w-full max-w-sm flex-col gap-3 rounded-2xl bg-surface p-5 shadow-xl">
        {children}
      </div>
    </div>,
    document.body,
  );
}

/**
 * Confirmar antes de un cambio importante (quitar, desconectar, pausar). Las
 * acciones rápidas, como abrir un chat, llamar o ubicar, no lo llevan.
 */
export function ConfirmDialog({
  title,
  points,
  confirmLabel,
  tone = "danger",
  onConfirm,
  onClose,
}: {
  title: string;
  points?: string[];
  confirmLabel: string;
  tone?: "danger" | "primary";
  onConfirm: () => void;
  onClose: () => void;
}) {
  return (
    <Modal label={title} onClose={onClose}>
      <p className="text-base font-semibold text-ink">{title}</p>
      {points && (
        <ul className="flex list-disc flex-col gap-1 pl-4 text-sm text-ink-2">
          {points.map((p) => (
            <li key={p}>{p}</li>
          ))}
        </ul>
      )}
      <div className="mt-1 flex gap-2">
        <button type="button" onClick={onClose} className="ease-ui h-10 flex-1 rounded-xl bg-sunken text-sm font-semibold text-ink-2">
          Cancelar
        </button>
        <button
          type="button"
          autoFocus
          onClick={() => {
            onClose();
            onConfirm();
          }}
          className={`ease-ui h-10 flex-1 rounded-xl text-sm font-semibold text-white ${tone === "danger" ? "bg-danger" : "bg-clapi"}`}
        >
          {confirmLabel}
        </button>
      </div>
    </Modal>
  );
}

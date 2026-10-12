"use client";

import { Check, Forward, Search, X } from "lucide-react";
import { useEffect, useState } from "react";
import { createPortal } from "react-dom";

import { KINDS, KindChip } from "@/components/KindChip";
import { conversationName, sendErrorText } from "@/lib/chat";
import { formatPhone, initials } from "@/lib/format";
import type { ConversationSummary } from "@/lib/types";

/**
 * Reenviar un mensaje a otro chat: se elige a quién y se confirma. Sale por
 * el mismo camino que cualquier mensaje del operador, así que el bot queda en
 * silencio en el chat de destino hasta que se lo devuelvan — y por eso hay
 * que confirmar en vez de enviar al primer toque.
 */
export function ForwardDialog({
  text,
  chats,
  onDone,
  onClose,
}: {
  text: string;
  chats: ConversationSummary[];
  onDone: (to: string) => void;
  onClose: () => void;
}) {
  const [query, setQuery] = useState("");
  const [targetId, setTargetId] = useState<number | null>(null);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const needle = query.trim().toLowerCase();
  const digits = needle.replace(/\D/g, "");
  const shown = chats.filter(
    (c) => !needle || conversationName(c).toLowerCase().includes(needle) || (digits !== "" && c.phone.replace(/\D/g, "").includes(digits)),
  );
  const target = chats.find((c) => c.id === targetId) ?? null;

  async function forward() {
    if (!target || sending) return;
    setSending(true);
    setError(null);
    const res = await fetch(`/api/conversations/${target.id}`, { method: "POST", body: JSON.stringify({ action: "send", text }) });
    setSending(false);
    if (res.ok) {
      onDone(conversationName(target));
    } else {
      const data = await res.json().catch(() => ({}));
      setError(sendErrorText(data.reason));
    }
  }

  return createPortal(
    <div onClick={onClose} className="fixed inset-0 z-60 flex items-end justify-center bg-clapi-deep/45 lg:items-center lg:p-6">
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Reenviar mensaje"
        onClick={(e) => e.stopPropagation()}
        className="flex max-h-[85dvh] w-full max-w-md flex-col rounded-t-3xl bg-surface shadow-xl lg:rounded-3xl"
      >
        <div className="flex items-center gap-2 px-4 pb-2 pt-4">
          <Forward size={18} className="shrink-0 text-clapi" />
          <h2 className="flex-1 font-semibold">Reenviar mensaje</h2>
          <button type="button" onClick={onClose} aria-label="Cerrar" className="ease-ui flex h-9 w-9 items-center justify-center rounded-xl text-ink-3 can-hover:hover:bg-sunken">
            <X size={18} />
          </button>
        </div>

        <p className="mx-4 line-clamp-3 whitespace-pre-wrap rounded-xl bg-clapi-soft px-3 py-2 text-sm text-ink">{text}</p>

        <label className="mx-4 mt-3 flex h-11 items-center gap-2 rounded-xl bg-sunken px-3 focus-within:ring-2 focus-within:ring-clapi/30">
          <Search size={16} className="shrink-0 text-ink-3" />
          <input
            autoFocus
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Buscar por nombre o teléfono"
            aria-label="Buscar chat"
            className="min-w-0 flex-1 bg-transparent outline-none"
          />
        </label>

        <div className="no-scrollbar mt-2 min-h-24 flex-1 overflow-y-auto px-2">
          {shown.length === 0 && <p className="px-4 py-8 text-center text-sm text-ink-3">{chats.length === 0 ? "Todavía no hay otros chats." : "Ningún chat coincide."}</p>}
          {shown.map((c) => {
            const picked = c.id === targetId;
            return (
              <button
                key={c.id}
                type="button"
                aria-pressed={picked}
                onClick={() => setTargetId(c.id)}
                className={`ease-ui flex w-full items-center gap-3 rounded-2xl px-2 py-2.5 text-left ${picked ? KINDS[c.kind].selected : "can-hover:hover:bg-sunken"}`}
              >
                <span className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-full text-sm font-bold ${KINDS[c.kind].tint}`}>
                  {initials(conversationName(c)) || "#"}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-semibold">{conversationName(c)}</span>
                  <span className="mt-0.5 flex items-center gap-1.5 text-xs text-ink-3">
                    <KindChip kind={c.kind} />
                    <span className="truncate tabular-nums">{formatPhone(c.phone)}</span>
                  </span>
                </span>
                {picked && <Check size={18} className="shrink-0 text-clapi" />}
              </button>
            );
          })}
        </div>

        <div className="border-t border-line px-4 pb-[calc(env(safe-area-inset-bottom)+0.75rem)] pt-3">
          {error ? (
            <p className="mb-2 rounded-lg bg-danger-soft px-3 py-2 text-xs text-danger">{error}</p>
          ) : (
            <p className="mb-2 text-xs text-ink-3">Sale por WhatsApp de inmediato. En ese chat el bot queda en silencio hasta que se lo devuelvas.</p>
          )}
          <div className="flex gap-2">
            <button type="button" onClick={onClose} className="ease-ui h-11 rounded-xl bg-sunken px-4 text-sm font-semibold text-ink-2">
              Cancelar
            </button>
            <button
              type="button"
              onClick={forward}
              disabled={!target || sending}
              className="ease-ui flex h-11 min-w-0 flex-1 items-center justify-center gap-2 rounded-xl bg-clapi px-4 text-sm font-semibold text-white disabled:opacity-40"
            >
              <Forward size={16} className="shrink-0" />
              <span className="truncate">{sending ? "Enviando…" : target ? `Reenviar a ${conversationName(target)}` : "Elige un chat"}</span>
            </button>
          </div>
        </div>
      </div>
    </div>,
    document.body,
  );
}

"use client";

import { MapPinOff, MapPinned } from "lucide-react";
import { useState } from "react";

import type { AdvisorQueryItem } from "@/lib/types";

type Answer = { valida: boolean | null; precio: string; direccion: string };

const FIELD = "ease-ui h-10 min-w-0 rounded-xl bg-surface px-3 text-sm outline-none focus:ring-2 focus:ring-clapi/40";
const CHOICE = "ease-ui h-10 flex-1 rounded-xl px-3 text-xs font-semibold";

const money = (n: number) => n.toLocaleString("es-CO");

/**
 * Lo que el bot le pregunta a la central de un pedido. Al responder, el bot
 * retoma la conversación.
 *
 * - Consulta de dirección: el mapa no ubicó una dirección. ¿Es válida y
 *   cuánto vale? El bot le manda el precio al restaurante, o le pide que
 *   corrija la dirección.
 * - Consulta de cobertura: la entrega quedó fuera de las zonas de servicio,
 *   cerca del borde. ¿Se hace? Si sí, el bot sigue con el precio (el de la
 *   tabla por km, que se puede cambiar); si no, le dice al restaurante que
 *   hasta allá no hay domicilio.
 */
export function AdvisorQueryPanel({ conversationId, items, onDone }: { conversationId: number; items: AdvisorQueryItem[]; onDone: () => void }) {
  const [answers, setAnswers] = useState<Record<number, Answer>>(() =>
    Object.fromEntries(
      items.map((i) => [i.indice, { valida: null, precio: i.cobertura ? money(i.cobertura.precio) : "", direccion: i.direccion.split(" · ")[0] }]),
    ),
  );
  const coverage = items.some((i) => i.cobertura);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const set = (indice: number, patch: Partial<Answer>) => setAnswers((prev) => ({ ...prev, [indice]: { ...prev[indice], ...patch } }));
  const price = (a: Answer) => Number(a.precio.replace(/\D/g, ""));
  const ready = items.every((i) => {
    const a = answers[i.indice];
    return a.valida === false || (a.valida === true && price(a) > 0);
  });

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!ready || busy) return;
    setBusy(true);
    setError(null);
    const respuestas = items.map((i) => {
      const a = answers[i.indice];
      const original = i.direccion.split(" · ")[0];
      return {
        indice: i.indice,
        valida: a.valida === true,
        precio: a.valida ? price(a) : null,
        direccion: !coverage && a.direccion.trim() && a.direccion.trim() !== original ? a.direccion.trim() : null,
      };
    });
    const res = await fetch(`/api/conversations/${conversationId}`, { method: "POST", body: JSON.stringify({ action: "address", respuestas }) });
    setBusy(false);
    if (res.ok) return onDone();
    const data = await res.json().catch(() => ({}));
    setError(typeof data.reason === "string" && !data.reason.startsWith("http_") ? data.reason : "No se pudo enviar la respuesta. Intenta de nuevo.");
  }

  return (
    <form onSubmit={submit} className="flex flex-col gap-3 border-b border-gold/30 bg-gold-soft/60 px-4 py-3">
      <p className="flex items-center gap-1.5 text-sm font-semibold text-gold-ink">
        {coverage ? (
          <>
            <MapPinned size={15} /> {items.length === 1 ? "Esta entrega queda" : "Estas entregas quedan"} fuera de las zonas de servicio, cerca del borde. ¿Se hace?
          </>
        ) : (
          <>
            <MapPinOff size={15} /> El bot no pudo ubicar {items.length === 1 ? "esta dirección" : "estas direcciones"}. ¿Es válida y cuánto vale?
          </>
        )}
      </p>
      {items.map((item) => {
        const a = answers[item.indice];
        return (
          <div key={item.indice} className="flex flex-col gap-2 rounded-xl bg-surface/70 p-3">
            <p className="text-xs text-ink-2">
              {item.direccion}
              {item.barrio ? ` · ${item.barrio}` : ""}
              {item.cliente ? ` · ${item.cliente}` : ""}
            </p>
            {item.cobertura && (
              <p className="text-xs font-medium text-ink">
                A {money(item.cobertura.metros)} m de «{item.cobertura.zona}» · por km vale $ {money(item.cobertura.precio)}
              </p>
            )}
            <div className="flex gap-2">
              <button
                type="button"
                onClick={() => set(item.indice, { valida: true })}
                className={`${CHOICE} ${a.valida === true ? "bg-ok text-white" : "bg-surface text-ink shadow-sm"}`}
              >
                {coverage ? "Sí, se hace" : "Es válida"}
              </button>
              <button
                type="button"
                onClick={() => set(item.indice, { valida: false })}
                className={`${CHOICE} ${a.valida === false ? "bg-danger text-white" : "bg-surface text-ink shadow-sm"}`}
              >
                {coverage ? "No se hace" : "No es válida"}
              </button>
            </div>
            {a.valida && (
              <div className="flex flex-col gap-2 sm:flex-row">
                {!coverage && (
                  <input
                    value={a.direccion}
                    onChange={(e) => set(item.indice, { direccion: e.target.value })}
                    placeholder="Dirección (corrígela si hace falta)"
                    aria-label="Dirección"
                    className={`${FIELD} flex-1`}
                  />
                )}
                <input
                  value={a.precio}
                  onChange={(e) => set(item.indice, { precio: e.target.value })}
                  inputMode="numeric"
                  placeholder="Valor del domicilio ($)"
                  aria-label="Valor del domicilio"
                  className={`${FIELD} sm:w-48`}
                />
              </div>
            )}
          </div>
        );
      })}
      {error && <p className="text-xs font-medium text-danger">{error}</p>}
      <button
        type="submit"
        disabled={!ready || busy}
        className="ease-ui h-10 rounded-xl bg-clapi px-4 text-sm font-semibold text-white disabled:opacity-50 sm:self-end"
      >
        {busy ? "Enviando…" : "Responder y devolver al bot"}
      </button>
    </form>
  );
}

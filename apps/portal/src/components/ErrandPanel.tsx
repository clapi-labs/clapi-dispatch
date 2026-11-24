"use client";

import { ShoppingBag } from "lucide-react";
import { useState } from "react";

const FIELD = "ease-ui h-10 min-w-0 rounded-xl bg-surface px-3 text-sm outline-none focus:ring-2 focus:ring-clapi/40";

/**
 * El panel de un chat que el bot pasó a la central por un encargo (comprarle o
 * traerle algo al restaurante). La central lo acuerda en la conversación, como
 * cualquier chat, y aquí solo decide:
 *
 * - «Crear encargo», con el precio que acordó: queda un viaje 🛍️ en Viajes, en
 *   Pendiente, que asigna ella; el bot le confirma al restaurante.
 * - «No crear»: no se crea nada y el bot no le escribe.
 *
 * En los dos casos el chat vuelve al bot. El precio no se calcula ni se valida.
 */
export function ErrandPanel({ conversationId, onDone }: { conversationId: number; onDone: (created: { code: string } | null) => void }) {
  const [price, setPrice] = useState("");
  const [busy, setBusy] = useState<"create" | "dismiss" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const amount = Number(price.replace(/\D/g, ""));

  async function decide(create: boolean) {
    if (busy || (create && !(amount > 0))) return;
    setBusy(create ? "create" : "dismiss");
    setError(null);
    const res = await fetch(`/api/conversations/${conversationId}`, {
      method: "POST",
      body: JSON.stringify(create ? { action: "errand", create: true, price: amount } : { action: "errand", create: false }),
    });
    const data = await res.json().catch(() => ({}));
    setBusy(null);
    if (res.ok) return onDone(create ? { code: String(data.code ?? "") } : null);
    // 409: otra persona ya lo decidió, o el chat ya volvió al bot. Lo que se ve se pone al día.
    if (res.status === 409) return onDone(null);
    setError(typeof data.error === "string" ? data.error : "No se pudo. Intenta de nuevo.");
  }

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        void decide(true);
      }}
      className="flex flex-col gap-2.5 border-b border-gold/30 bg-gold-soft/60 px-4 py-3"
    >
      <div className="flex flex-col gap-0.5">
        <p className="flex items-center gap-1.5 text-sm font-semibold text-gold-ink">
          <ShoppingBag size={15} /> Encargo
        </p>
        <p className="text-xs leading-snug text-ink-2">
          Acuérdalo con el restaurante en el chat. Al crearlo queda en Viajes, en Pendiente, y lo asignas tú. El chat vuelve al bot.
        </p>
      </div>
      <div className="flex flex-col gap-2 sm:flex-row">
        <input
          value={price}
          onChange={(e) => setPrice(e.target.value.replace(/\D/g, "") ? Number(e.target.value.replace(/\D/g, "")).toLocaleString("es-CO") : "")}
          inputMode="numeric"
          placeholder="Precio acordado ($)"
          aria-label="Precio del encargo"
          className={`${FIELD} sm:w-48`}
        />
        <div className="flex flex-1 gap-2 sm:justify-end">
          <button
            type="button"
            onClick={() => void decide(false)}
            disabled={busy !== null}
            className="ease-ui h-10 flex-1 rounded-xl bg-surface px-4 text-sm font-semibold text-ink-2 shadow-sm disabled:opacity-50 sm:flex-none"
          >
            {busy === "dismiss" ? "Devolviendo…" : "No crear"}
          </button>
          <button
            type="submit"
            disabled={busy !== null || !(amount > 0)}
            className="ease-ui h-10 flex-1 rounded-xl bg-clapi px-4 text-sm font-semibold text-white disabled:opacity-50 sm:flex-none"
          >
            {busy === "create" ? "Creando…" : "Crear encargo"}
          </button>
        </div>
      </div>
      {error && <p className="text-xs font-medium text-danger">{error}</p>}
    </form>
  );
}

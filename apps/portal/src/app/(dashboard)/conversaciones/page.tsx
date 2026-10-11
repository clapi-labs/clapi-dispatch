"use client";

import { ArrowLeft, Bike, Bot, Check, Hand, Headset, MessagesSquare, RotateCcw, SendHorizontal, Store } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

import { formatCOP, formatPhone, initials } from "@/lib/format";
import type { ChatMessage, ConversationKind, ConversationSummary, DraftFields } from "@/lib/types";
import { usePolling } from "@/lib/use-polling";

function timeLabel(iso: string) {
  const d = new Date(iso);
  const sameDay = d.toDateString() === new Date().toDateString();
  return sameDay
    ? d.toLocaleTimeString("es-CO", { hour: "2-digit", minute: "2-digit" })
    : d.toLocaleDateString("es-CO", { day: "numeric", month: "short" });
}

/** Al motorizado se le ve con su nombre de Flota, no con el de su WhatsApp. */
function name(c: ConversationSummary) {
  return c.courierName || c.displayName || formatPhone(c.phone);
}

/** Un restaurante y un motorizado nunca se ven igual: cada uno con su ícono,
 *  su texto y su color, en la lista, en el encabezado y en las burbujas. */
const KINDS = {
  restaurant: {
    label: "Restaurante",
    Icon: Store,
    tint: "bg-clapi/15 text-clapi-ink",
    selected: "bg-clapi-soft/70",
    bubble: "bg-surface",
  },
  courier: {
    label: "Motorizado",
    Icon: Bike,
    tint: "bg-courier/15 text-courier-ink",
    selected: "bg-courier-soft/70",
    bubble: "bg-courier-soft",
  },
};

type Tab = ConversationKind | "all";

const TABS: { key: Tab; label: string; empty: string }[] = [
  { key: "all", label: "Todos", empty: "Cuando alguien escriba por WhatsApp, el chat aparece acá." },
  { key: "restaurant", label: "Restaurantes", empty: "Cuando un restaurante escriba por WhatsApp, el chat aparece acá." },
  { key: "courier", label: "Motorizados", empty: "Cuando un motorizado escriba por WhatsApp, el chat aparece acá." },
];

function inTab(c: ConversationSummary, tab: Tab) {
  return tab === "all" || c.kind === tab;
}

function isDesktop() {
  return window.matchMedia("(min-width: 1024px)").matches;
}

function KindChip({ kind }: { kind: ConversationKind }) {
  const { label, Icon, tint } = KINDS[kind];
  return (
    <span className={`flex shrink-0 items-center gap-1 rounded-md px-1.5 py-0.5 text-[11px] font-semibold ${tint}`}>
      <Icon size={11} /> {label}
    </span>
  );
}

const DRAFT_FIELDS: { key: keyof DraftFields; label: string }[] = [
  { key: "origenRestaurante", label: "Restaurante" },
  { key: "direccionEntrega", label: "Dirección" },
  { key: "telefonoCliente", label: "Teléfono" },
  { key: "valorACobrar", label: "Valor" },
  { key: "metodoPago", label: "Pago" },
];

/** Lo que el bot ya entendió del pedido en curso: la memoria entre mensajes. */
function DraftPanel({ draft }: { draft: DraftFields }) {
  const done = DRAFT_FIELDS.filter((f) => draft[f.key] !== null).length;
  return (
    <div className="border-b border-line bg-clapi-soft/60 px-4 py-3">
      <div className="mb-2 flex items-center justify-between text-xs font-semibold text-clapi-ink">
        <span className="flex items-center gap-1.5">
          <Bot size={14} /> El bot está armando el pedido
        </span>
        <span className="tabular-nums">{done}/5</span>
      </div>
      <div className="flex flex-wrap gap-1.5">
        {DRAFT_FIELDS.map((f) => {
          const value = draft[f.key];
          const text = value === null ? f.label : f.key === "valorACobrar" ? formatCOP(Number(value)) : String(value);
          return (
            <span
              key={f.key}
              className={`flex max-w-full items-center gap-1 truncate rounded-lg px-2 py-1 text-xs ${
                value === null ? "border border-dashed border-ink-3/40 text-ink-3" : "bg-surface font-medium text-ink shadow-sm"
              }`}
            >
              {value !== null && <Check size={12} className="shrink-0 text-ok" />}
              <span className="truncate">{text}</span>
            </span>
          );
        })}
      </div>
    </div>
  );
}

/** `role: "restaurant"` es todo lo que entra por WhatsApp, también lo que
 *  escribe un motorizado: de quién es el chat lo dice `kind`. */
function Bubble({ message, kind }: { message: ChatMessage; kind: ConversationKind }) {
  const mine = message.role !== "restaurant";
  return (
    <div className={`flex ${mine ? "justify-end" : "justify-start"}`}>
      <div
        className={`max-w-[85%] whitespace-pre-wrap rounded-2xl px-3.5 py-2 text-sm leading-relaxed shadow-sm ${
          message.role === "restaurant"
            ? `rounded-bl-md text-ink ${KINDS[kind].bubble}`
            : message.role === "bot"
              ? "rounded-br-md bg-clapi text-white"
              : "rounded-br-md bg-gold text-clapi-deep"
        }`}
      >
        {message.role !== "restaurant" && (
          <p className={`mb-0.5 text-[11px] font-semibold ${message.role === "bot" ? "text-white/70" : "text-clapi-deep/70"}`}>
            {message.role === "bot" ? "Bot" : "Asesor"}
          </p>
        )}
        {message.text}
        <p className={`mt-1 text-right text-[10px] ${message.role === "restaurant" ? "text-ink-3" : "opacity-70"}`}>
          {timeLabel(message.createdAt)}
        </p>
      </div>
    </div>
  );
}

export default function ConversacionesPage() {
  const [list, setList] = useState<ConversationSummary[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [thread, setThread] = useState<ChatMessage[]>([]);
  const bottomRef = useRef<HTMLDivElement>(null);
  const lastCount = useRef(0);
  const [tab, setTab] = useState<Tab>("all");
  // La pestaña va también en un ref: `loadList` la lee al volver del servidor,
  // y un sondeo que ya iba en camino no debe abrir un chat de la pestaña anterior.
  const tabRef = useRef<Tab>("all");

  const loadList = useCallback(async () => {
    const res = await fetch("/api/conversations", { cache: "no-store" });
    if (!res.ok) return;
    const data: ConversationSummary[] = await res.json();
    setList(data);
    setLoaded(true);
    // En escritorio, abrir de entrada la conversación más reciente de la pestaña.
    const first = data.find((c) => inTab(c, tabRef.current));
    if (first && isDesktop()) {
      setSelectedId((current) => current ?? first.id);
    }
  }, []);

  const loadThread = useCallback(async (id: number) => {
    const res = await fetch(`/api/conversations/${id}`, { cache: "no-store" });
    if (res.ok) setThread(await res.json());
  }, []);

  usePolling(loadList, 2500);
  const pollThread = useCallback(() => {
    if (selectedId !== null) loadThread(selectedId);
  }, [selectedId, loadThread]);
  usePolling(pollThread, 2000, selectedId !== null);

  // Bajar al último mensaje solo cuando llega uno nuevo, no en cada sondeo.
  useEffect(() => {
    if (thread.length !== lastCount.current) {
      bottomRef.current?.scrollIntoView({ behavior: lastCount.current === 0 ? "auto" : "smooth" });
      lastCount.current = thread.length;
    }
  }, [thread]);


  const selected = list.find((c) => c.id === selectedId) ?? null;
  const visible = list.filter((c) => inTab(c, tab));

  const [draftText, setDraftText] = useState("");
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);

  async function act(action: "pause" | "resume") {
    if (!selected) return;
    // Optimista: el botón responde al toque, el sondeo confirma.
    setList((prev) => prev.map((c) => (c.id === selected.id ? { ...c, botPaused: action === "pause" } : c)));
    await fetch(`/api/conversations/${selected.id}`, { method: "POST", body: JSON.stringify({ action }) });
    loadList();
  }

  async function send(e: React.FormEvent) {
    e.preventDefault();
    const text = draftText.trim();
    if (!selected || !text || sending) return;
    setSending(true);
    setSendError(null);
    const res = await fetch(`/api/conversations/${selected.id}`, { method: "POST", body: JSON.stringify({ action: "send", text }) });
    setSending(false);
    if (res.ok) {
      setDraftText("");
      loadThread(selected.id);
    } else {
      const data = await res.json().catch(() => ({}));
      setSendError(
        data.reason === "no_bot" || data.reason === "bad_secret"
          ? "El portal no está bien conectado con el bot (BOT_URL / INTERNAL_SECRET)."
          : "WhatsApp rechazó el mensaje. Si este número no escribe hace más de 24 h, Meta no deja escribirle primero.",
      );
      loadThread(selected.id);
    }
  }

  function open(id: number | null) {
    lastCount.current = 0;
    setThread([]);
    setSelectedId(id);
  }

  function switchTab(next: Tab) {
    tabRef.current = next;
    setTab(next);
    if (selected && inTab(selected, next)) return;
    // El chat abierto no es de esta pestaña: en escritorio pasa al primero que sí.
    const first = isDesktop() ? list.find((c) => inTab(c, next)) : undefined;
    open(first?.id ?? null);
  }

  return (
    <div className="flex h-full lg:p-6">
      <div className="flex min-h-0 w-full overflow-hidden lg:card">
        {/* Lista de chats */}
        <aside className={`min-h-0 w-full flex-col border-line lg:flex lg:w-[340px] lg:border-r ${selected ? "hidden" : "flex"}`}>
          <div className="border-b border-line px-4 py-4">
            <h1 className="text-xl font-bold tracking-tight">Conversaciones</h1>
            <p className="text-sm text-ink-3">El bot atendiendo en vivo</p>
            <div role="tablist" aria-label="Tipo de contacto" className="mt-3 flex gap-1 rounded-xl bg-sunken p-1">
              {TABS.map((t) => {
                const chats = list.filter((c) => inTab(c, t.key));
                // El punto avisa que en ese grupo hay chats esperando a una persona,
                // aunque se esté mirando la otra pestaña. En "Todos" sobraría.
                const waiting = t.key === "all" ? 0 : chats.filter((c) => c.botPaused).length;
                const active = t.key === tab;
                return (
                  <button
                    key={t.key}
                    type="button"
                    role="tab"
                    aria-selected={active}
                    title={waiting > 0 ? `${waiting} esperando un asesor` : undefined}
                    onClick={() => switchTab(t.key)}
                    className={`ease-ui relative flex h-9 flex-auto items-center justify-center gap-1.5 whitespace-nowrap rounded-lg px-2 text-xs font-semibold ${
                      active ? "bg-surface text-ink shadow-sm" : "text-ink-2 can-hover:hover:text-ink"
                    }`}
                  >
                    {t.label}
                    <span className="font-medium tabular-nums text-ink-3">{chats.length}</span>
                    {waiting > 0 && (
                      <>
                        <span className="absolute right-1.5 top-1.5 h-2 w-2 rounded-full bg-gold" />
                        <span className="sr-only">, {waiting} esperando un asesor</span>
                      </>
                    )}
                  </button>
                );
              })}
            </div>
          </div>
          <div className="no-scrollbar flex-1 overflow-y-auto">
            {loaded && visible.length === 0 && (
              <div className="flex flex-col items-center gap-2 px-6 py-16 text-center text-sm text-ink-3">
                <MessagesSquare size={22} className="opacity-60" />
                {TABS.find((t) => t.key === tab)?.empty}
              </div>
            )}
            {visible.map((c) => (
              <button
                key={c.id}
                type="button"
                onClick={() => open(c.id)}
                className={`ease-ui flex w-full items-center gap-3 border-b border-line px-4 py-3.5 text-left ${
                  c.id === selectedId ? KINDS[c.kind].selected : "can-hover:hover:bg-sunken"
                }`}
              >
                <span className={`relative flex h-11 w-11 shrink-0 items-center justify-center rounded-full text-sm font-bold ${KINDS[c.kind].tint}`}>
                  {initials(name(c)) || "#"}
                  {c.botPaused && (
                    <span className="absolute -bottom-0.5 -right-0.5 flex h-5 w-5 items-center justify-center rounded-full bg-gold ring-2 ring-surface">
                      <Headset size={11} className="text-clapi-deep" />
                    </span>
                  )}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="flex items-baseline justify-between gap-2">
                    <span className="truncate text-sm font-semibold">{name(c)}</span>
                    <span className="shrink-0 text-[11px] text-ink-3">{timeLabel(c.lastMessageAt)}</span>
                  </span>
                  <span className="mt-1 flex items-center gap-1.5 text-xs text-ink-3">
                    <KindChip kind={c.kind} />
                    <span className="min-w-0 truncate">
                      {c.botPaused ? (
                        <span className="font-semibold text-gold-ink">Esperando un asesor</span>
                      ) : (
                        <>
                          {c.lastRole === "bot" && "Bot: "}
                          {c.lastText}
                        </>
                      )}
                    </span>
                  </span>
                </span>
              </button>
            ))}
          </div>
        </aside>

        {/* Hilo */}
        <section className={`min-h-0 flex-1 flex-col bg-canvas ${selected ? "flex" : "hidden lg:flex"}`}>
          {!selected ? (
            <div className="flex flex-1 flex-col items-center justify-center gap-2 text-sm text-ink-3">
              <MessagesSquare size={26} className="opacity-50" />
              Elige una conversación
            </div>
          ) : (
            <>
              <header className="flex items-center gap-3 border-b border-line bg-surface px-3 py-3 lg:px-5">
                <button
                  type="button"
                  onClick={() => setSelectedId(null)}
                  className="flex h-10 w-10 items-center justify-center rounded-xl text-ink-2 lg:hidden"
                  aria-label="Volver"
                >
                  <ArrowLeft size={20} />
                </button>
                <div className="min-w-0 flex-1 leading-tight">
                  <p className="truncate font-semibold">{name(selected)}</p>
                  <p className="mt-1 flex items-center gap-1.5 text-xs text-ink-3">
                    <KindChip kind={selected.kind} />
                    <span className="min-w-0 truncate">{formatPhone(selected.phone)}</span>
                  </p>
                </div>
                {selected.botPaused ? (
                  <span className="flex items-center gap-1.5 rounded-lg bg-gold-soft px-2.5 py-1.5 text-xs font-semibold text-gold-ink">
                    <Headset size={13} /> Tú atiendes
                  </span>
                ) : (
                  <button
                    type="button"
                    onClick={() => act("pause")}
                    className="ease-ui flex h-9 items-center gap-1.5 rounded-lg bg-client px-3 text-xs font-semibold text-white shadow-sm can-hover:hover:brightness-110"
                  >
                    <Hand size={14} /> Intervenir
                  </button>
                )}
              </header>

              {selected.botPaused && (
                <div className="flex flex-wrap items-center gap-3 border-b border-gold/30 bg-gold-soft px-4 py-3">
                  <Headset size={18} className="shrink-0 text-gold-ink" />
                  <p className="min-w-0 flex-1 text-sm text-gold-ink">
                    <strong>El bot está en silencio.</strong> {selected.escalationReason ?? "Un asesor atiende este chat."}
                  </p>
                  <button
                    type="button"
                    onClick={() => act("resume")}
                    className="ease-ui flex h-9 items-center gap-1.5 rounded-lg bg-surface px-3 text-xs font-semibold text-ink shadow-sm"
                  >
                    <RotateCcw size={13} /> Devolver al bot
                  </button>
                </div>
              )}

              {!selected.botPaused && selected.draft && <DraftPanel draft={selected.draft} />}

              <div className="no-scrollbar flex flex-1 flex-col gap-2 overflow-y-auto px-3 py-4 lg:px-6">
                {thread.map((m) => (
                  <Bubble key={m.id} message={m} kind={selected.kind} />
                ))}
                <div ref={bottomRef} />
              </div>

              {selected.botPaused ? (
                <form onSubmit={send} className="border-t border-line bg-surface px-3 pb-3 pt-2 lg:px-5">
                  {sendError && <p className="mb-2 rounded-lg bg-danger-soft px-3 py-2 text-xs text-danger">{sendError}</p>}
                  <div className="flex items-end gap-2">
                    <textarea
                      value={draftText}
                      onChange={(e) => setDraftText(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter" && !e.shiftKey) {
                          e.preventDefault();
                          send(e);
                        }
                      }}
                      rows={1}
                      placeholder="Escribe como la central…"
                      className="ease-ui max-h-32 min-h-11 flex-1 resize-none rounded-xl bg-sunken px-3.5 py-2.5 outline-none focus:ring-2 focus:ring-clapi/30"
                    />
                    <button
                      type="submit"
                      disabled={sending || !draftText.trim()}
                      aria-label="Enviar"
                      className="ease-ui flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-client text-white disabled:opacity-40"
                    >
                      <SendHorizontal size={18} />
                    </button>
                  </div>
                </form>
              ) : (
                <div className="flex items-center justify-center gap-2 border-t border-line bg-surface px-4 py-3 text-xs text-ink-3">
                  <Bot size={14} className="text-clapi" /> El bot está atendiendo. Toca <strong className="text-ink-2">Intervenir</strong> para escribir tú.
                </div>
              )}
            </>
          )}
        </section>
      </div>
    </div>
  );
}

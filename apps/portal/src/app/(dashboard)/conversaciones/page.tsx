"use client";

import {
  ArrowLeft,
  Bot,
  Check,
  Hand,
  Headset,
  ImageOff,
  MessagesSquare,
  MoreVertical,
  Pin,
  RotateCcw,
  SendHorizontal,
  TriangleAlert,
} from "lucide-react";
import { isErrandReason } from "@dispatch/shared/domain/errand";
import { AnimatePresence, motion } from "motion/react";
import { Fragment, memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { flushSync } from "react-dom";

import { AdvisorQueryPanel } from "@/components/AdvisorQueryPanel";
import { ChatContactActions } from "@/components/ChatContactActions";
import { ErrandPanel } from "@/components/ErrandPanel";
import { ForwardDialog } from "@/components/ForwardDialog";
import { ImageViewer } from "@/components/ImageViewer";
import { KINDS, KindChip } from "@/components/KindChip";
import { MessageMenu } from "@/components/MessageMenu";
import { conversationName as name, needsHelp, phoneFromHash, sendErrorText, TAKEOVER_REASON } from "@/lib/chat";
import { copyText } from "@/lib/clipboard";
import { useSwipePanes } from "@/lib/use-swipe-panes";
import { useBusiness } from "@/lib/business";
import { formatPhone, initials, samePhone } from "@/lib/format";
import { captionOf, mediaUrl, placeholderText } from "@/lib/media";
import type { ChatMessage, ConversationKind, ConversationSummary } from "@/lib/types";
import { useLive } from "@/lib/live";
import { touches, type Change } from "@/lib/live-event";
import { mergeThread, refreshAfter, THREAD_PAGE, type ThreadPage } from "@/lib/thread";
import { createSendQueue } from "@/lib/send-queue";

function timeLabel(iso: string) {
  const d = new Date(iso);
  const sameDay = d.toDateString() === new Date().toDateString();
  return sameDay
    ? d.toLocaleTimeString("es-CO", { hour: "2-digit", minute: "2-digit" })
    : d.toLocaleDateString("es-CO", { day: "numeric", month: "short" });
}

/** En cada mensaje va solo la hora, como en WhatsApp. El día lo dice el separador de arriba. */
function messageTime(iso: string) {
  return new Date(iso).toLocaleTimeString("es-CO", { hour: "numeric", minute: "2-digit" });
}

/** El separador entre días del hilo: "Hoy", "Ayer" o la fecha. */
function dayLabel(iso: string) {
  const d = new Date(iso);
  const today = new Date();
  const yesterday = new Date(today);
  yesterday.setDate(today.getDate() - 1);
  if (d.toDateString() === today.toDateString()) return "Hoy";
  if (d.toDateString() === yesterday.toDateString()) return "Ayer";
  return d.toLocaleDateString("es-CO", {
    weekday: "long",
    day: "numeric",
    month: "long",
    ...(d.getFullYear() === today.getFullYear() ? {} : { year: "numeric" }),
  });
}

type Tab = ConversationKind | "all";

const TABS: { key: Tab; label: string; empty: string }[] = [
  { key: "all", label: "Todos", empty: "Cuando alguien escriba por WhatsApp, el chat aparece acá." },
  { key: "restaurant", label: "Restaurantes", empty: "Cuando un restaurante escriba por WhatsApp, el chat aparece acá." },
  { key: "courier", label: "Motorizados", empty: "Cuando un motorizado escriba por WhatsApp, el chat aparece acá." },
];

const TAB_KEYS = TABS.map((t) => t.key);

function inTab(c: ConversationSummary, tab: Tab) {
  return tab === "all" || c.kind === tab;
}

function isDesktop() {
  return window.matchMedia("(min-width: 1024px)").matches;
}

const INTERVENE =
  "ease-ui h-9 shrink-0 items-center gap-1.5 rounded-lg bg-clapi px-3 text-xs font-semibold text-white shadow-sm can-hover:hover:brightness-110";

/** La cita encima de la burbuja, como en WhatsApp: quién escribió el
 *  mensaje citado y su comienzo. Tocarla lleva hasta ese mensaje. */
function Quote({ quote, contactName, onClick }: { quote: NonNullable<ChatMessage["quote"]>; contactName: string; onClick: () => void }) {
  const author = quote.role === "bot" ? "Bot" : quote.role === "agent" ? "Asesor" : contactName;
  return (
    <button
      type="button"
      onClick={onClick}
      className="mb-1 block w-full min-w-0 rounded-lg border-l-4 border-clapi bg-ink/5 px-2.5 py-1.5 text-left can-hover:hover:bg-ink/10"
    >
      <span className="block text-[11px] font-semibold text-clapi-ink">{author}</span>
      <span className="line-clamp-2 whitespace-pre-wrap text-xs text-ink-2">{quote.text}</span>
    </button>
  );
}

/** Foto registrada del contacto (restaurante o motorizado), o sus iniciales. */
function ContactAvatar({
  contact,
  sizeClass,
  children,
}: {
  contact: ConversationSummary;
  sizeClass: string;
  children?: React.ReactNode;
}) {
  return (
    <span className={`relative flex shrink-0 items-center justify-center rounded-full font-bold ${sizeClass} ${KINDS[contact.kind].tint}`}>
      {contact.photo ? (
        // eslint-disable-next-line @next/next/no-img-element -- la foto es un data URL guardado en la base.
        <img src={contact.photo} alt="" className="h-full w-full rounded-full object-cover" />
      ) : (
        initials(name(contact)) || "#"
      )}
      {children}
    </span>
  );
}

/** La foto del mensaje: la miniatura (se abre en el visor) o, si ya no está, un aviso limpio en su lugar. */
function ChatImage({ message, onOpen }: { message: ChatMessage; onOpen: () => void }) {
  const media = message.media!;
  const [failed, setFailed] = useState(false);

  if (media.status !== "stored" || failed) {
    return (
      <div className="mb-1 flex w-60 max-w-full items-center gap-2.5 rounded-xl border border-dashed border-line bg-sunken/70 px-3 py-3 text-xs leading-snug text-ink-2">
        <ImageOff size={18} className="shrink-0 text-ink-3" />
        <span>{placeholderText(failed ? null : media)}</span>
      </div>
    );
  }

  // El espacio se reserva con su proporción: el hilo no salta cuando carga la foto.
  const ratio = media.width && media.height ? media.width / media.height : 4 / 3;
  const width = Math.round(Math.min(256, Math.max(140, 320 * ratio)));
  return (
    <button
      type="button"
      onClick={onOpen}
      aria-label="Abrir imagen"
      style={{ width, aspectRatio: ratio }}
      className="mb-1 block max-w-full cursor-zoom-in overflow-hidden rounded-xl bg-sunken"
    >
      {/* eslint-disable-next-line @next/next/no-img-element -- sale de un endpoint autenticado y ya viene achicada */}
      <img
        src={media.src ?? mediaUrl(message.id)}
        alt={captionOf(message.text) || "Imagen del chat"}
        loading="lazy"
        decoding="async"
        draggable={false}
        onError={() => setFailed(true)}
        className="h-full w-full object-cover"
      />
    </button>
  );
}

/**
 * `role: "restaurant"` es todo lo que entra por WhatsApp, también lo que
 * escribe un motorizado. Colores de WhatsApp: lo que llega va en blanco y lo
 * que sale en verde; quién lo mandó, el bot o un asesor, lo dice la etiqueta.
 * `wrap-anywhere`: un enlace o una palabra más largos que la burbuja se parten
 * en vez de salirse de ella y ensanchar el hilo.
 *
 * Las opciones del mensaje se abren con los tres puntos, que solo existen
 * donde hay cursor y aparecen al pasarlo por encima. En pantalla táctil no
 * hay botón: se mantiene presionada la burbuja. `onMenu` recibe el botón para
 * anclar el menú, o nada.
 */
const Bubble = memo(function Bubble({
  message,
  contactName,
  highlighted,
  onMenu,
  onQuote,
  onImage,
}: {
  message: ChatMessage;
  /** Cómo se llama quien escribe del otro lado, para la cita. */
  contactName: string;
  /** Recién señalado desde una cita: se ilumina un momento. */
  highlighted: boolean;
  onMenu: (message: ChatMessage, anchor: DOMRect | null) => void;
  onQuote: (messageId: number) => void;
  onImage: (message: ChatMessage) => void;
}) {
  const mine = message.role !== "restaurant";
  const time = useMemo(() => messageTime(message.createdAt), [message.createdAt]);
  const hold = useRef<ReturnType<typeof setTimeout> | null>(null);
  const touched = useRef(false);
  /** Presionar la burbuja abre el menú: el toque que sigue no debe abrir también la foto. */
  const held = useRef(false);
  const caption = message.media ? captionOf(message.text) : message.text;

  function cancelHold() {
    if (hold.current) clearTimeout(hold.current);
    hold.current = null;
  }

  return (
    // `content-visibility: auto`: el navegador no pinta ni calcula las burbujas que están
    // fuera de pantalla. Con un hilo de miles de mensajes, sin esto cada tecla cuesta
    // ~45 ms de pintado aunque React no toque nada. `shrink-0`: una burbuja omitida no
    // tiene altura mínima y, sin él, el hilo (flex en columna) la encogería.
    <div
      id={`msg-${message.id}`}
      className={`group flex shrink-0 scroll-my-24 items-center gap-1 [contain-intrinsic-size:auto_64px] [content-visibility:auto] ${mine ? "flex-row-reverse" : ""}`}
    >
      <div
        onPointerDown={(e) => {
          touched.current = e.pointerType === "touch";
          held.current = false;
          if (touched.current) {
            hold.current = setTimeout(() => {
              held.current = true;
              onMenu(message, null);
            }, 450);
          }
        }}
        onPointerUp={cancelHold}
        onPointerCancel={cancelHold}
        onPointerLeave={cancelHold}
        // En táctil, el menú del navegador saldría encima del nuestro.
        onContextMenu={(e) => {
          if (touched.current) e.preventDefault();
        }}
        className={`relative max-w-[85%] min-w-0 select-none whitespace-pre-wrap wrap-anywhere rounded-2xl px-3.5 py-2 text-sm leading-relaxed text-ink shadow-sm [-webkit-touch-callout:none] can-hover:select-text ${
          mine ? "rounded-br-md bg-chat-out" : "rounded-bl-md bg-surface"
        } ${highlighted ? "ring-2 ring-clapi" : ""}`}
      >
        {mine && (
          <p className={`mb-0.5 flex items-center gap-1 text-[11px] font-semibold ${message.role === "bot" ? "text-clapi-ink" : "text-ink"}`}>
            {message.role === "bot" ? <Bot size={12} /> : <Headset size={12} />}
            {message.role === "bot" ? "Bot" : "Asesor"}
          </p>
        )}
        {message.quote && (
          <Quote quote={message.quote} contactName={contactName} onClick={() => onQuote(message.quote!.id)} />
        )}
        {!!message.tripCodes?.length && (
          <p className="mb-1 flex flex-wrap gap-1">
            {message.tripCodes.map((code) => (
              <span key={code} className="rounded-md bg-clapi-soft px-1.5 py-0.5 font-mono text-[11px] font-semibold text-clapi-ink">
                Pedido {code}
              </span>
            ))}
          </p>
        )}
        {/* La hora al lado del texto, como en WhatsApp: una copia invisible le guarda el
            sitio al final de la última línea; si no cabe, salta sola a una línea nueva. */}
        {message.media && (
          <ChatImage
            message={message}
            onOpen={() => {
              if (held.current) held.current = false;
              else onImage(message);
            }}
          />
        )}
        {caption}
        <span aria-hidden className="invisible ml-2 inline-block whitespace-nowrap text-[10px] leading-none">
          {time}
        </span>
        <span className={`absolute bottom-1.5 right-3 whitespace-nowrap text-[10px] leading-none ${mine ? "text-ink-2/80" : "text-ink-3"}`}>
          {time}
        </span>
      </div>
      <button
        type="button"
        aria-label="Opciones del mensaje"
        aria-haspopup="menu"
        onClick={(e) => onMenu(message, e.currentTarget.getBoundingClientRect())}
        className="ease-ui hidden h-8 w-8 shrink-0 items-center justify-center rounded-full text-ink-2 opacity-0 hover:bg-surface/70 hover:text-ink focus-visible:opacity-100 group-hover:opacity-100 can-hover:flex"
      >
        <MoreVertical size={16} />
      </button>
    </div>
  );
});

/**
 * El historial. Va aparte y memoizado: solo se vuelve a pintar cuando cambian
 * los mensajes, la cita iluminada o el contacto, nunca por lo que se escribe
 * en la caja ni por un sondeo que trae lo mismo.
 */
const Thread = memo(function Thread({
  thread,
  contactName,
  highlight,
  onMenu,
  onQuote,
  onImage,
  bottomRef,
}: {
  thread: ChatMessage[];
  contactName: string;
  highlight: number | null;
  onMenu: (message: ChatMessage, anchor: DOMRect | null) => void;
  onQuote: (messageId: number) => void;
  onImage: (message: ChatMessage) => void;
  bottomRef: React.RefObject<HTMLDivElement | null>;
}) {
  // La etiqueta del día se calcula una vez por mensaje, no en cada pintada.
  const days = useMemo(() => thread.map((m) => dayLabel(m.createdAt)), [thread]);
  return (
    <>
      {thread.map((m, i) => (
        <Fragment key={m.id}>
          {(i === 0 || days[i - 1] !== days[i]) && (
            <p className="my-1 self-center rounded-lg bg-surface/90 px-3 py-1 text-[11px] font-medium text-ink-2 shadow-sm first-letter:uppercase">
              {days[i]}
            </p>
          )}
          <Bubble message={m} contactName={contactName} highlighted={highlight === m.id} onMenu={onMenu} onQuote={onQuote} onImage={onImage} />
        </Fragment>
      ))}
      <div ref={bottomRef} />
    </>
  );
});

/**
 * La caja de texto y el envío. El borrador vive acá, no en la página: teclear
 * solo pinta este componente. Al enviar, la caja se vacía de una vez y el envío
 * sigue en segundo plano (en orden); si falla, el texto vuelve a la caja siempre
 * que no se haya empezado a escribir otro mensaje. La caja nunca se bloquea.
 */
function Composer({
  conversationId,
  inputRef,
  onSent,
  onResume,
}: {
  conversationId: number;
  inputRef: React.RefObject<HTMLTextAreaElement | null>;
  onSent: () => void;
  /** Con "Devolver al bot" en el pie; sin él, nada. */
  onResume: (() => void) | null;
}) {
  const [draftText, setDraftText] = useState("");
  const [sendError, setSendError] = useState<string | null>(null);
  const queue = useRef(
    createSendQueue(async (text) => {
      const res = await fetch(`/api/conversations/${conversationId}`, { method: "POST", body: JSON.stringify({ action: "send", text }) });
      if (res.ok) return { ok: true };
      const data = await res.json().catch(() => ({}));
      return { ok: false, reason: data.reason };
    }),
  );

  // La caja crece con lo que se escribe o se pega (un pedido de varias líneas), hasta su tope.
  // Solo se toca la altura cuando cambia: al crecer, basta con leer `scrollHeight`;
  // volver a "auto" en cada tecla invalida el diseño de toda la página.
  const lastLength = useRef(0);
  useLayoutEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    const shrinking = draftText.length < lastLength.current;
    lastLength.current = draftText.length;
    if (shrinking) el.style.height = "auto";
    else if (el.scrollHeight <= el.clientHeight) return;
    el.style.height = `${el.scrollHeight}px`;
  }, [draftText, inputRef]);

  function send(e: React.SyntheticEvent) {
    e.preventDefault();
    const text = draftText.trim();
    if (!text) return;
    setDraftText("");
    setSendError(null);
    queue.current(text, {
      onFail: (unsent, reason) => {
        setSendError(sendErrorText(reason));
        setDraftText((current) => (current ? current : unsent));
      },
      onDone: onSent,
    });
  }

  return (
    <form onSubmit={send} className="relative border-t border-line bg-surface px-3 pb-3 pt-2 lg:px-5">
      {sendError && <p className="mb-2 rounded-lg bg-danger-soft px-3 py-2 text-xs text-danger">{sendError}</p>}
      {/* Flota sobre el hilo, a la altura del botón de enviar; el hilo le deja espacio abajo. */}
      {onResume && (
        <button type="button" onClick={onResume} className={`absolute bottom-full right-3 z-10 mb-2 flex lg:right-5 ${INTERVENE}`}>
          <RotateCcw size={13} /> Devolver al bot
        </button>
      )}
      <div className="flex items-end gap-2">
        <textarea
          ref={inputRef}
          value={draftText}
          onChange={(e) => setDraftText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) send(e);
          }}
          rows={1}
          placeholder="Escribe como la central…"
          className="max-h-32 min-h-10 flex-1 resize-none rounded-xl bg-sunken px-3.5 py-2.5 text-sm leading-5 outline-none focus:ring-2 focus:ring-clapi/30"
        />
        <button
          type="submit"
          disabled={!draftText.trim()}
          aria-label="Enviar"
          className="ease-ui flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-clapi text-white disabled:opacity-40"
        >
          <SendHorizontal size={16} />
        </button>
      </div>
    </form>
  );
}

export default function ConversacionesPage() {
  const [list, setList] = useState<ConversationSummary[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  // El hilo va por páginas (lib/thread.ts): los últimos mensajes al abrir, los
  // anteriores con «Cargar anteriores» y, con cada aviso de este chat, solo lo
  // del final. El ref tiene siempre lo mismo que el estado, para leerlo al
  // volver una respuesta sin esperar a otro render.
  const [thread, setThreadState] = useState<ChatMessage[]>([]);
  const threadRef = useRef<ChatMessage[]>([]);
  const setThread = useCallback((next: ChatMessage[]) => {
    threadRef.current = next;
    setThreadState(next);
  }, []);
  const [hasOlder, setHasOlder] = useState(false);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const loadingOlderRef = useRef(false);
  const selectedRef = useRef<number | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  // Al poner los anteriores arriba, lo que se estaba leyendo no se mueve.
  const keepScroll = useRef<{ height: number; top: number } | null>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  // El último mensaje que ya se mostró: se baja al final solo si cambia.
  const lastBottomId = useRef<number | null>(null);
  const [tab, setTab] = useState<Tab>("all");
  // La pestaña va también en un ref: `loadList` la lee al volver del servidor,
  // y un sondeo que ya iba en camino no debe abrir un chat de la pestaña anterior.
  const tabRef = useRef<Tab>("all");
  const [notice, setNotice] = useState<string | null>(null);

  // Al llegar desde un teléfono de otra pantalla (#tel=57300…) se abre ese chat
  // en cuanto carga la lista. El número no se queda en la barra de direcciones.
  const wanted = useRef<string | null>(null);
  const lastList = useRef("");
  const intervenedIds = useRef(new Set<number>());

  // Si el operador tocó "Intervenir" y sale de Conversaciones (cambia a otra
  // pantalla del portal o cierra la pestaña), devuelve esos chats al bot.
  useEffect(() => {
    const release = () => {
      if (intervenedIds.current.size === 0) return;
      const ids = [...intervenedIds.current];
      intervenedIds.current.clear();
      for (const id of ids) {
        void fetch(`/api/conversations/${id}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action: "resume", onlyIfTakeover: true }),
          keepalive: true,
        });
      }
    };
    window.addEventListener("pagehide", release);
    return () => {
      window.removeEventListener("pagehide", release);
      release();
    };
  }, []);

  /** Otro chat: el hilo empieza vacío y una respuesta del anterior que venga en
   *  camino ya no se pinta. */
  const showChat = useCallback(
    (id: number | null) => {
      selectedRef.current = id;
      lastBottomId.current = null;
      keepScroll.current = null;
      setThread([]);
      setHasOlder(false);
      setSelectedId(id);
    },
    [setThread],
  );

  const loadList = useCallback(async () => {
    const res = await fetch("/api/conversations", { cache: "no-store" });
    if (!res.ok) return;
    const raw = await res.text();
    const data: ConversationSummary[] = JSON.parse(raw);
    // Un sondeo que trae lo mismo no repinta nada.
    if (raw !== lastList.current) {
      lastList.current = raw;
      setList(data);
    }
    setLoaded(true);
    if (wanted.current) {
      const phone = wanted.current;
      wanted.current = null;
      const target = data.find((c) => samePhone(c.phone, phone));
      if (target) {
        tabRef.current = "all";
        setTab("all");
        showChat(target.id);
      } else {
        setNotice(`Todavía no hay conversación con ${formatPhone(phone)}`);
      }
    }
    // En escritorio, abrir de entrada la conversación más reciente de la pestaña.
    const first = data.find((c) => inTab(c, tabRef.current));
    if (first && isDesktop() && selectedRef.current === null) showChat(first.id);
  }, [showChat]);

  /**
   * Trae el hilo del chat `id`. Vacío: la última página. Si ya hay mensajes,
   * solo lo nuevo y los últimos `REFRESH_OVERLAP` (por si cambió alguno), y se
   * junta con lo que había: un hilo de miles de mensajes ya no se vuelve a
   * bajar entero con cada aviso (H2).
   */
  const loadThread = useCallback(
    async (id: number) => {
      const current = threadRef.current;
      const query = current.length === 0 ? `limit=${THREAD_PAGE}` : `after=${refreshAfter(current)}`;
      const res = await fetch(`/api/conversations/${id}?${query}`, { cache: "no-store" });
      if (!res.ok) return;
      const page = (await res.json()) as ThreadPage;
      if (selectedRef.current !== id) return;
      if (page.reset || threadRef.current.length === 0) {
        setThread(page.messages);
        setHasOlder(page.hasOlder ?? false);
        return;
      }
      const next = mergeThread(threadRef.current, page.messages);
      if (next !== threadRef.current) setThread(next);
    },
    [setThread],
  );

  /** «Cargar anteriores»: la página de antes del primer mensaje que se ve. */
  const loadOlder = useCallback(async () => {
    const id = selectedRef.current;
    const first = threadRef.current[0];
    if (id === null || !first || loadingOlderRef.current) return;
    loadingOlderRef.current = true;
    setLoadingOlder(true);
    try {
      const res = await fetch(`/api/conversations/${id}?before=${first.id}&limit=${THREAD_PAGE}`, { cache: "no-store" });
      if (!res.ok) return;
      const page = (await res.json()) as ThreadPage;
      if (selectedRef.current !== id) return;
      const el = scrollRef.current;
      keepScroll.current = el ? { height: el.scrollHeight, top: el.scrollTop } : null;
      setThread(mergeThread(threadRef.current, page.messages));
      setHasOlder(page.hasOlder ?? false);
    } finally {
      loadingOlderRef.current = false;
      setLoadingOlder(false);
    }
  }, [setThread]);

  // El número también puede llegar con la pantalla ya abierta: al tocar una
  // alerta del celular (components/AppBridge.tsx) cambia solo el fragmento.
  useEffect(() => {
    const take = (reload: boolean) => {
      // Solo se anota si viene uno: en desarrollo React corre el efecto dos veces,
      // y la segunda ya no encuentra el número en la dirección.
      const phone = phoneFromHash(window.location.hash);
      if (!phone) return;
      wanted.current = phone;
      window.history.replaceState(null, "", window.location.pathname);
      if (reload) void loadList();
    };
    take(false);
    const onHash = () => take(true);
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, [loadList]);

  // La bandeja marca quién es motorizado: también cambia con la flota.
  useLive(loadList, ["conversations", "messages", "couriers"]);
  const pollThread = useCallback(() => {
    if (selectedId !== null) loadThread(selectedId);
  }, [selectedId, loadThread]);
  // Solo los avisos de este chat (o los que no dicen de cuál): un mensaje de
  // otro restaurante ya no vuelve a pedir el hilo abierto.
  const acceptThread = useCallback((change: Change) => selectedId !== null && touches(change, selectedId), [selectedId]);
  useLive(pollThread, ["messages"], selectedId !== null, acceptThread);
  // Al cambiar de chat se carga el nuevo de una vez, sin esperar un aviso.
  // En un setTimeout: el setState de la respuesta no ocurre dentro del efecto.
  useEffect(() => {
    if (selectedId === null) return;
    const id = setTimeout(() => loadThread(selectedId), 0);
    return () => clearTimeout(id);
  }, [selectedId, loadThread]);

  // Tras «Cargar anteriores», lo que se estaba leyendo queda en el mismo lugar.
  useLayoutEffect(() => {
    const keep = keepScroll.current;
    const el = scrollRef.current;
    if (!keep || !el) return;
    keepScroll.current = null;
    el.scrollTop = el.scrollHeight - keep.height + keep.top;
  }, [thread]);

  // Bajar al último mensaje solo cuando llega uno nuevo al final: no en cada
  // sondeo ni al cargar los anteriores.
  useEffect(() => {
    const lastId = thread.length > 0 ? thread[thread.length - 1].id : null;
    if (lastId === null || lastId === lastBottomId.current) return;
    const first = lastBottomId.current === null;
    bottomRef.current?.scrollIntoView({ behavior: first ? "auto" : "smooth" });
    // Las burbujas fuera de pantalla miden un estimado hasta que se pintan: al abrir el
    // chat, un segundo ajuste ya con las del final pintadas deja el hilo realmente abajo.
    if (first) requestAnimationFrame(() => bottomRef.current?.scrollIntoView({ behavior: "auto" }));
    lastBottomId.current = lastId;
  }, [thread]);


  const selected = list.find((c) => c.id === selectedId) ?? null;

  // En el celular el chat tapa la lista: sin esta pausa corta, el toque no alcanza a verse.
  const [tapped, setTapped] = useState<number | null>(null);
  function tap(id: number) {
    setTapped(id);
    setTimeout(() => {
      open(id);
      setTapped(null);
    }, 200);
  }

  // Tocar una cita lleva al mensaje citado y lo ilumina un momento.
  const [highlight, setHighlight] = useState<number | null>(null);
  const goToMessage = useCallback((messageId: number) => {
    document.getElementById(`msg-${messageId}`)?.scrollIntoView({ behavior: "smooth", block: "center" });
    setHighlight(messageId);
    setTimeout(() => setHighlight((current) => (current === messageId ? null : current)), 1600);
  }, []);
  const panes = useSwipePanes(TAB_KEYS, tab, switchTab);
  // Pausa general: el bot no responde a nadie y todos los chats se escriben
  // directo, como un WhatsApp normal, sin intervenir uno por uno.
  const { paused: businessPaused } = useBusiness();

  const inputRef = useRef<HTMLTextAreaElement>(null);

  const [menu, setMenu] = useState<{ message: ChatMessage; anchor: DOMRect | null } | null>(null);
  const [forwarding, setForwarding] = useState<ChatMessage | null>(null);
  const [viewing, setViewing] = useState<{ src: string; caption: string; width: number | null; height: number | null } | null>(null);
  const openImage = useCallback((message: ChatMessage) => {
    if (message.media?.status !== "stored") return;
    setViewing({ src: message.media.src ?? mediaUrl(message.id), caption: captionOf(message.text), width: message.media.width, height: message.media.height });
  }, [setViewing]);

  const openMenu = useCallback(
    // En celular siempre es la hoja de abajo, se abra con los puntos o presionando.
    (message: ChatMessage, anchor: DOMRect | null) => setMenu({ message, anchor: isDesktop() ? anchor : null }),
    [setMenu],
  );

  useEffect(() => {
    if (!notice) return;
    const id = setTimeout(() => setNotice(null), 2200);
    return () => clearTimeout(id);
  }, [notice]);

  async function copy(text: string, done: string) {
    setNotice((await copyText(text)) ? done : "No se pudo copiar");
  }

  async function act(action: "pause" | "resume") {
    if (!selected) return;
    if (action === "pause") intervenedIds.current.add(selected.id);
    else intervenedIds.current.delete(selected.id);
    // Optimista: el botón responde al toque, el sondeo confirma.
    const patch =
      action === "pause" ? { botPaused: true, escalationReason: TAKEOVER_REASON } : { botPaused: false, escalationReason: null };
    const update = () => setList((prev) => prev.map((c) => (c.id === selected.id ? { ...c, ...patch } : c)));
    if (action === "pause") {
      // Al intervenir, el cursor ya queda en la caja de texto. `flushSync` pinta la caja
      // antes del `focus()`, todavía dentro del toque: solo así el celular abre el teclado.
      flushSync(update);
      inputRef.current?.focus();
    } else {
      update();
    }
    await fetch(`/api/conversations/${selected.id}`, { method: "POST", body: JSON.stringify({ action }) });
    loadList();
  }

  const afterSend = useCallback(() => {
    if (selectedId !== null) loadThread(selectedId);
  }, [selectedId, loadThread]);

  function open(id: number | null) {
    showChat(id);
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
          <div className="border-b border-line px-4 py-3">
            <div role="tablist" aria-label="Tipo de contacto" className="flex gap-1 rounded-xl bg-sunken p-1">
              {/* Sin contadores: los chats que piden ayuda ya se ven fijados arriba en amarillo,
                  y su número está en la burbuja de "Conversaciones" en la navegación. */}
              {TABS.map((t) => {
                const active = t.key === tab;
                return (
                  <button
                    key={t.key}
                    type="button"
                    role="tab"
                    aria-selected={active}
                    onClick={() => switchTab(t.key)}
                    className={`ease-ui flex h-9 flex-auto items-center justify-center whitespace-nowrap rounded-lg px-2 text-xs font-semibold ${
                      active ? "bg-surface text-ink shadow-sm" : "text-ink-2 can-hover:hover:text-ink"
                    }`}
                  >
                    {t.label}
                  </button>
                );
              })}
            </div>
          </div>
          {/* Un panel por pestaña, en carrusel: se pasa de una a otra deslizando. */}
          <div ref={panes} className="no-scrollbar flex min-h-0 flex-1 snap-x snap-mandatory overflow-x-auto overscroll-x-contain">
            {TABS.map((t) => {
              const visible = list.filter((c) => inTab(c, t.key));
              return (
                <div key={t.key} className="no-scrollbar h-full w-full shrink-0 snap-start snap-always overflow-y-auto">
                {loaded && visible.length === 0 && (
                  <div className="flex flex-col items-center gap-2 px-6 py-16 text-center text-sm text-ink-3">
                    <MessagesSquare size={22} className="opacity-60" />
                    {t.empty}
                  </div>
                )}
                {visible.map((c) => {
                  const help = needsHelp(c);
                  return (
                    <button
                      key={c.id}
                      type="button"
                      onClick={() => tap(c.id)}
                      className={`ease-ui relative flex w-full items-center gap-3 border-b border-line px-4 py-3.5 text-left duration-100 active:scale-[0.97] ${
                        c.id === tapped ? `scale-[0.97] ${c.kind === "courier" ? "bg-courier/25" : "bg-clapi/25"}` : c.id === selectedId ? KINDS[c.kind].selected : help ? "bg-gold-soft/70 can-hover:hover:bg-gold-soft" : "can-hover:hover:bg-sunken"
                      }`}
                    >
                      {/* Franja amarilla a la izquierda: este chat pide ayuda. */}
                      {help && <span className="absolute inset-y-0 left-0 w-1 bg-gold" />}
                      <ContactAvatar contact={c} sizeClass="h-11 w-11 text-sm">
                        {c.botPaused && (
                          <span className="absolute -bottom-0.5 -right-0.5 flex h-5 w-5 items-center justify-center rounded-full bg-gold ring-2 ring-surface">
                            {help ? <TriangleAlert size={11} className="text-clapi-deep" /> : <Headset size={11} className="text-clapi-deep" />}
                          </span>
                        )}
                      </ContactAvatar>
                      <span className="min-w-0 flex-1">
                        <span className="flex items-baseline justify-between gap-2">
                          <span className="truncate text-sm font-semibold">{name(c)}</span>
                          <span className="flex shrink-0 items-center gap-1 text-[11px] text-ink-3">
                            {/* Fijado arriba hasta que vuelva al bot. */}
                            {c.botPaused && <Pin size={11} className={help ? "fill-gold text-gold-ink" : ""} aria-label="Fijado" />}
                            {timeLabel(c.lastMessageAt)}
                          </span>
                        </span>
                        <span className="mt-1 flex items-center gap-1.5 text-xs text-ink-3">
                          <span className="min-w-0 truncate">
                            {help ? (
                              <span className="font-semibold text-gold-ink">Necesita tu ayuda</span>
                            ) : c.botPaused ? (
                              <span className="font-medium text-gold-ink">Tú atiendes</span>
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
                  );
                })}
                </div>
              );
            })}
          </div>
        </aside>

        {/* Hilo. `min-w-0`: en celular no puede ensancharse por un nombre o un teléfono largos. */}
        <section className={`min-h-0 min-w-0 flex-1 flex-col bg-chat ${selected ? "flex" : "hidden lg:flex"}`}>
          {!selected ? (
            <div className="flex flex-1 flex-col items-center justify-center gap-2 text-sm text-ink-3">
              <MessagesSquare size={26} className="opacity-50" />
              Elige una conversación
            </div>
          ) : (
            <>
              <header className="flex items-center gap-2 border-b border-line bg-surface px-3 py-3 sm:gap-3 lg:px-5">
                <button
                  type="button"
                  onClick={() => showChat(null)}
                  className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl text-ink-2 lg:hidden"
                  aria-label="Volver"
                >
                  <ArrowLeft size={20} />
                </button>
                <ContactAvatar contact={selected} sizeClass="h-9 w-9 text-xs" />
                <div className="min-w-0 flex-1 leading-tight">
                  <p className="truncate font-semibold">{name(selected)}</p>
                  <p className="mt-1 flex items-center gap-1.5 text-xs text-ink-3">
                    <KindChip kind={selected.kind} />
                    <span className="min-w-0 truncate">{formatPhone(selected.phone)}</span>
                  </p>
                </div>
                <ChatContactActions phone={selected.phone} onCopy={(text) => copy(text, "Número copiado")} />
                {/* En celular el encabezado es del contacto: "Intervenir" baja a la barra del pie,
                    y "Tú atiendes" ya lo dice la franja amarilla. */}
                {businessPaused ? null : selected.botPaused ? (
                  <span className="hidden shrink-0 items-center gap-1.5 rounded-lg bg-gold-soft px-2.5 py-1.5 text-xs font-semibold text-gold-ink sm:flex">
                    <Headset size={13} /> Tú atiendes
                  </span>
                ) : (
                  <button type="button" onClick={() => act("pause")} className={`hidden sm:flex ${INTERVENE}`}>
                    <Hand size={14} /> Intervenir
                  </button>
                )}
              </header>

              {selected.botPaused && !businessPaused && (
                <div className="flex items-center gap-2 border-b border-gold/30 bg-gold-soft px-3 py-1.5 lg:px-4">
                  <Headset size={14} className="shrink-0 text-gold-ink" />
                  {/* Solo la razón por la que el bot escaló: que un operador tomó el chat ya se sabe. */}
                  <p className="min-w-0 flex-1 text-xs leading-snug text-gold-ink">
                    {selected.escalationReason && selected.escalationReason !== TAKEOVER_REASON ? selected.escalationReason : "Tú atiendes"}
                  </p>
                </div>
              )}

              {selected.botPaused && !businessPaused && isErrandReason(selected.escalationReason) ? (
                <ErrandPanel
                  key={`encargo-${selected.id}`}
                  conversationId={selected.id}
                  onDone={(created) => {
                    if (created) setNotice(created.code ? `Encargo ${created.code} creado` : "Encargo creado");
                    // Optimista: el chat ya volvió al bot.
                    setList((prev) => prev.map((c) => (c.id === selected.id ? { ...c, botPaused: false, escalationReason: null } : c)));
                    loadList();
                    loadThread(selected.id);
                  }}
                />
              ) : null}

              {selected.botPaused && selected.advisorQuery?.length ? (
                <AdvisorQueryPanel
                  key={`consulta-${selected.id}`}
                  conversationId={selected.id}
                  items={selected.advisorQuery}
                  onDone={() => {
                    loadList();
                    loadThread(selected.id);
                  }}
                />
              ) : null}

              {/* El hilo solo se mueve hacia arriba y abajo: nunca se arrastra de lado. */}
              <div
                ref={scrollRef}
                className={`no-scrollbar flex flex-1 flex-col gap-2 overflow-y-auto overflow-x-hidden px-3 pt-4 lg:px-6 ${selected.botPaused && !businessPaused ? "pb-14" : "pb-4"}`}
              >
                {hasOlder && (
                  <button
                    type="button"
                    onClick={() => void loadOlder()}
                    disabled={loadingOlder}
                    className="my-1 self-center rounded-lg bg-surface/90 px-3 py-1 text-xs font-medium text-clapi-ink shadow-sm hover:bg-surface disabled:opacity-60"
                  >
                    {loadingOlder ? "Cargando…" : "Cargar anteriores"}
                  </button>
                )}
                <Thread
                  thread={thread}
                  contactName={name(selected)}
                  highlight={highlight}
                  onMenu={openMenu}
                  onQuote={goToMessage}
                  onImage={openImage}
                  bottomRef={bottomRef}
                />
              </div>

              {selected.botPaused || businessPaused ? (
                <Composer
                  key={`composer-${selected.id}`}
                  conversationId={selected.id}
                  inputRef={inputRef}
                  onSent={afterSend}
                  onResume={selected.botPaused && !businessPaused ? () => void act("resume") : null}
                />
              ) : (
                <div className="flex items-center justify-center gap-2 border-t border-line bg-surface px-3 pb-3 pt-2 text-sm text-ink-3 lg:px-5">
                  <Bot size={16} className="shrink-0 text-clapi" />
                  <span className="sm:hidden">El bot está atendiendo.</span>
                  <span className="hidden sm:inline">
                    El bot está atendiendo. Toca <strong className="text-ink-2">Intervenir</strong> para escribir tú.
                  </span>
                  <button type="button" onClick={() => act("pause")} className={`ml-auto flex sm:hidden ${INTERVENE}`}>
                    <Hand size={14} /> Intervenir
                  </button>
                </div>
              )}
            </>
          )}
        </section>
      </div>

      {menu && (
        <MessageMenu
          message={menu.message}
          anchor={menu.anchor}
          onCopy={copy}
          onForward={() => {
            setForwarding(menu.message);
            setMenu(null);
          }}
          onClose={() => setMenu(null)}
        />
      )}

      {viewing && <ImageViewer {...viewing} onClose={() => setViewing(null)} />}

      {forwarding && (
        <ForwardDialog
          text={forwarding.text}
          chats={list.filter((c) => c.id !== selectedId)}
          onDone={(to) => {
            setForwarding(null);
            setNotice(`Reenviado a ${to}`);
            loadList();
          }}
          onClose={() => setForwarding(null)}
        />
      )}

      <AnimatePresence>
        {notice && (
          <motion.div
            role="status"
            initial={{ opacity: 0, y: 12 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 8 }}
            transition={{ duration: 0.18 }}
            className="fixed bottom-[calc(5.5rem+env(safe-area-inset-bottom))] left-1/2 z-70 flex -translate-x-1/2 items-center gap-2 whitespace-nowrap rounded-full bg-clapi-deep px-4 py-2.5 text-sm font-medium text-white shadow-xl lg:bottom-10"
          >
            <Check size={15} className="text-gold" /> {notice}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

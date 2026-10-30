import { Client } from "pg";

/**
 * Escucha los avisos que Postgres manda cuando cambian viajes, motos o chats
 * (migración 0003_avisos_en_vivo: canal "dispatch_changes", el mensaje es el
 * nombre de la tabla). Una sola conexión por proceso, compartida por todos los
 * navegadores conectados; se abre con el primer interesado y se reabre sola si
 * se cae.
 *
 * Además de las tablas, los interesados reciben "ready" cuando la escucha
 * queda activa y "down" cuando se pierde: mientras esté caída, el tablero
 * vuelve a preguntar cada pocos segundos. Contra Neon (HTTP, sin LISTEN) nunca
 * queda activa y el tablero se queda en ese modo.
 */

export const CHANGES_CHANNEL = "dispatch_changes";

type Listener = (event: string) => void;

type State = { listeners: Set<Listener>; client: Client | null; ready: boolean; retry: NodeJS.Timeout | null };

// En globalThis: en desarrollo Next recarga los módulos y no debe abrir otra conexión.
const g = globalThis as { __dispatchChanges?: State };
const state: State = (g.__dispatchChanges ??= { listeners: new Set(), client: null, ready: false, retry: null });

function emit(event: string) {
  for (const listener of state.listeners) listener(event);
}

function connect() {
  const url = process.env.DATABASE_URL;
  if (state.client || !url || url.includes("neon.tech")) return;

  const client = new Client({ connectionString: url });
  state.client = client;

  const lost = () => {
    if (state.client !== client) return;
    state.client = null;
    if (state.ready) {
      state.ready = false;
      emit("down");
    }
    client.end().catch(() => {});
    // Se reintenta mientras haya alguien mirando.
    if (state.listeners.size > 0 && !state.retry) {
      state.retry = setTimeout(() => {
        state.retry = null;
        connect();
      }, 3000);
    }
  };

  client.on("error", lost);
  client.on("end", lost);
  client.on("notification", (msg) => {
    if (msg.channel === CHANGES_CHANNEL && msg.payload) emit(msg.payload);
  });

  client
    .connect()
    .then(() => client.query(`LISTEN ${CHANGES_CHANNEL}`))
    .then(() => {
      if (state.client !== client) return;
      state.ready = true;
      emit("ready");
    })
    .catch(lost);
}

/** Avisa a `listener` de cada cambio. Si la escucha ya está activa, recibe
 *  "ready" enseguida. Devuelve la función para dejar de escuchar. */
export function subscribeChanges(listener: Listener): () => void {
  state.listeners.add(listener);
  if (state.ready) listener("ready");
  else connect();
  return () => {
    state.listeners.delete(listener);
  };
}

"use client";

import { BellOff, BellRing, CheckCircle2, Download, Laptop, LogOut, Send, Smartphone, TriangleAlert } from "lucide-react";
import { useCallback, useEffect, useState } from "react";

import { ConfirmDialog } from "@/components/Modal";
import {
  canPromptInstall,
  disablePush,
  enablePush,
  getPushStatus,
  isStandalone,
  loadPublicKey,
  onInstallChange,
  platform,
  promptInstall,
  registerServiceWorker,
  sendTestPush,
  type Platform,
  type PushStatus,
} from "@/lib/push";

/**
 * Alertas al celular (docs/INTERVENCION-MANUAL.md, «Alertas al celular»): en
 * qué estado están en este equipo, cómo activarlas, cómo instalar el portal
 * como app y las sesiones abiertas, para cerrar la de un celular perdido.
 */

type OpenSession = {
  id: number;
  userName: string;
  device: string;
  installed: boolean;
  createdAt: string;
  lastSeenAt: string;
  expiresAt: string;
  alerts: boolean;
};

const STATUS: Record<PushStatus, { label: string; tone: "ok" | "off" | "bad"; text: string }> = {
  on: {
    label: "Activas en este equipo",
    tone: "ok",
    text: "Te llegan los chats que piden ayuda y las motos asignadas, aunque el portal esté cerrado y el celular bloqueado.",
  },
  off: {
    label: "Apagadas en este equipo",
    tone: "off",
    text: "Actívalas para que te lleguen los chats que piden ayuda y las motos asignadas con el portal cerrado.",
  },
  denied: {
    label: "Bloqueadas en los ajustes",
    tone: "bad",
    text: "Las notificaciones del portal están bloqueadas en este celular. Desbloquéalas en los ajustes y vuelve aquí.",
  },
  "needs-install": {
    label: "Falta instalar el portal",
    tone: "off",
    text: "En iPhone las alertas solo funcionan con el portal agregado a la pantalla de inicio y abierto desde su ícono.",
  },
  "ios-too-old": {
    label: "iOS muy antiguo",
    tone: "bad",
    text: "Este iPhone necesita iOS 16.4 o más reciente para recibir alertas. Actualízalo en Ajustes › General › Actualización de software.",
  },
  unsupported: {
    label: "No disponibles en este navegador",
    tone: "bad",
    text: "Este navegador no recibe notificaciones. En Android usa Chrome; en iPhone, Safari con el portal en la pantalla de inicio.",
  },
};

const TONE = {
  ok: "bg-ok-soft text-ok",
  off: "bg-sunken text-ink-2",
  bad: "bg-danger-soft text-danger",
};

const button =
  "ease-ui flex h-11 items-center justify-center gap-2 rounded-xl px-4 text-sm font-semibold focus-visible:outline-gold disabled:opacity-60";

function when(iso: string) {
  return new Date(iso).toLocaleString("es-CO", { day: "numeric", month: "short", hour: "numeric", minute: "2-digit" });
}

function Steps({ items }: { items: React.ReactNode[] }) {
  return (
    <ol className="flex list-decimal flex-col gap-1.5 pl-5 text-sm text-ink-2">
      {items.map((item, i) => (
        <li key={i}>{item}</li>
      ))}
    </ol>
  );
}

function UnblockSteps({ os }: { os: Platform }) {
  if (os === "ios") {
    return (
      <Steps
        items={[
          <>Abre <b>Ajustes</b> › <b>Notificaciones</b>.</>,
          <>Busca <b>Clapi</b> y activa <b>Permitir notificaciones</b>, con sonido.</>,
          <>Vuelve al portal.</>,
        ]}
      />
    );
  }
  return (
    <Steps
      items={[
        <>Mantén presionado el ícono de <b>Clapi</b> › <b>Información de la app</b> › <b>Notificaciones</b> y actívalas.</>,
        <>Si usas el portal en Chrome sin instalar: toca el candado junto a la dirección › <b>Permisos</b> › <b>Notificaciones</b> › Permitir.</>,
        <>Vuelve al portal.</>,
      ]}
    />
  );
}

function InstallSteps({ os }: { os: Platform }) {
  if (os === "ios") {
    return (
      <Steps
        items={[
          <>Abre el portal en <b>Safari</b>.</>,
          <>Toca <b>Compartir</b> (el cuadro con la flecha hacia arriba).</>,
          <>Elige <b>Agregar a inicio</b> y toca <b>Agregar</b>.</>,
          <>Cierra Safari y abre <b>Clapi</b> desde el ícono. Inicia sesión ahí y activa las alertas en esta pantalla.</>,
        ]}
      />
    );
  }
  return (
    <Steps
      items={[
        <>Abre el portal en <b>Chrome</b>.</>,
        <>Toca el menú <b>⋮</b> › <b>Agregar a la pantalla principal</b> (o <b>Instalar aplicación</b>) › <b>Instalar</b>.</>,
        <>Abre <b>Clapi</b> desde el ícono y activa las alertas en esta pantalla.</>,
      ]}
    />
  );
}

export default function AlertasPage() {
  const [status, setStatus] = useState<PushStatus | null>(null);
  const [os, setOs] = useState<Platform>("other");
  const [installed, setInstalled] = useState(false);
  const [canInstall, setCanInstall] = useState(false);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [sessions, setSessions] = useState<OpenSession[] | null>(null);
  const [current, setCurrent] = useState<number | null>(null);
  const [noSession, setNoSession] = useState(false);
  const [closing, setClosing] = useState<OpenSession | null>(null);

  const refreshStatus = useCallback(async () => {
    setOs(platform());
    setInstalled(isStandalone());
    setCanInstall(canPromptInstall());
    setStatus(await getPushStatus().catch(() => "unsupported" as const));
  }, []);

  const loadSessions = useCallback(async () => {
    const res = await fetch("/api/sessions", { cache: "no-store" }).catch(() => null);
    if (res?.status === 401) {
      setNoSession(true);
      return;
    }
    const body = await res?.json().catch(() => null);
    if (!body) return;
    setSessions(body.sessions);
    setCurrent(body.current);
  }, []);

  // Al volver de los ajustes del celular (bloquear o desbloquear) se ve enseguida.
  useEffect(() => {
    const first = setTimeout(() => {
      void refreshStatus();
      void loadSessions();
    }, 0);
    registerServiceWorker()?.catch(() => {});
    void loadPublicKey();
    const onVisible = () => {
      if (document.visibilityState === "visible") void refreshStatus();
    };
    document.addEventListener("visibilitychange", onVisible);
    const offInstall = onInstallChange(() => void refreshStatus());
    let permission: PermissionStatus | null = null;
    navigator.permissions
      ?.query({ name: "notifications" })
      .then((p) => {
        permission = p;
        p.onchange = () => void refreshStatus();
      })
      .catch(() => {});
    return () => {
      clearTimeout(first);
      document.removeEventListener("visibilitychange", onVisible);
      offInstall();
      if (permission) permission.onchange = null;
    };
  }, [refreshStatus, loadSessions]);

  async function enable() {
    setBusy(true);
    setNotice(null);
    try {
      const next = await enablePush();
      setStatus(next);
      if (next === "on") {
        const sent = await sendTestPush();
        setNotice(sent ? "Listo. Te mandamos una alerta de prueba." : "Quedaron activas, pero la prueba no salió. Intenta «Enviar una de prueba».");
        void loadSessions();
      }
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "No se pudieron activar. Intenta de nuevo.");
      void refreshStatus();
    } finally {
      setBusy(false);
    }
  }

  async function disable() {
    setBusy(true);
    setNotice(null);
    await disablePush().catch(() => {});
    await refreshStatus();
    void loadSessions();
    setBusy(false);
  }

  async function test() {
    setBusy(true);
    setNotice(null);
    const sent = await sendTestPush();
    setNotice(sent ? "Enviada. Debe llegar en unos segundos." : "No salió. Apaga y vuelve a activar las alertas.");
    setBusy(false);
  }

  async function install() {
    await promptInstall().catch(() => false);
    await refreshStatus();
  }

  async function closeSession(session: OpenSession) {
    const res = await fetch(`/api/sessions/${session.id}`, { method: "DELETE" }).catch(() => null);
    const body = await res?.json().catch(() => null);
    if (body?.own) {
      window.location.replace("/login");
      return;
    }
    void loadSessions();
  }

  const info = status ? STATUS[status] : null;
  const mobile = os !== "other";

  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-5 px-4 py-5 lg:px-8 lg:py-7">
      <section className="card flex flex-col gap-4 p-5">
        <header className="flex items-start gap-3">
          <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-clapi-soft text-clapi-ink">
            <BellRing size={20} />
          </span>
          <div className="min-w-0 flex-1">
            <h1 className="text-base font-semibold">Alertas al celular</h1>
            <p className="text-sm text-ink-3">Las mismas alertas que suenan en el portal, como notificación del celular.</p>
          </div>
        </header>

        {info ? (
          <div role="status" className={`flex flex-col gap-1 rounded-xl px-4 py-3 ${TONE[info.tone]}`}>
            <p className="flex items-center gap-2 text-sm font-semibold">
              {info.tone === "ok" ? <CheckCircle2 size={16} /> : info.tone === "bad" ? <TriangleAlert size={16} /> : <BellOff size={16} />}
              {info.label}
            </p>
            <p className="text-sm text-ink-2">{info.text}</p>
          </div>
        ) : (
          <div className="h-20 animate-pulse rounded-xl bg-sunken" />
        )}

        {noSession && (
          <p className="rounded-xl bg-warn-soft px-4 py-3 text-sm text-ink">
            Para activar las alertas, <a href="/login?next=/alertas" className="font-semibold underline">inicia sesión</a> en este equipo.
          </p>
        )}

        {status === "denied" && <UnblockSteps os={os} />}

        <div className="flex flex-wrap gap-2">
          {status === "off" && !noSession && (
            <button type="button" onClick={enable} disabled={busy} className={`${button} bg-clapi text-white`}>
              <BellRing size={16} /> {busy ? "Activando…" : "Activar alertas"}
            </button>
          )}
          {status === "on" && (
            <>
              <button type="button" onClick={test} disabled={busy} className={`${button} bg-clapi text-white`}>
                <Send size={16} /> Enviar una de prueba
              </button>
              <button type="button" onClick={disable} disabled={busy} className={`${button} bg-sunken text-ink-2`}>
                <BellOff size={16} /> Apagar en este equipo
              </button>
            </>
          )}
        </div>

        {notice && <p className="text-sm text-ink-2">{notice}</p>}

        {status === "on" && mobile && (
          <p className="text-xs text-ink-3">
            Si no suenan, revisa que el celular no esté en silencio o en «No molestar», y que las notificaciones de Clapi tengan sonido en los ajustes.
          </p>
        )}
      </section>

      {mobile && (
        <section className="card flex flex-col gap-4 p-5">
          <header className="flex items-start gap-3">
            <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-clapi-soft text-clapi-ink">
              <Smartphone size={20} />
            </span>
            <div className="min-w-0 flex-1">
              <h2 className="text-base font-semibold">El portal como app</h2>
              <p className="text-sm text-ink-3">
                {installed
                  ? "Abierto desde el ícono de Clapi: la sesión dura 30 días en este celular."
                  : "Con el ícono de Clapi en la pantalla de inicio se abre a pantalla completa y la sesión dura 30 días."}
              </p>
            </div>
            {installed && <CheckCircle2 size={20} className="shrink-0 text-ok" />}
          </header>
          {!installed && (
            <>
              {canInstall && (
                <button type="button" onClick={install} className={`${button} self-start bg-clapi text-white`}>
                  <Download size={16} /> Instalar Clapi
                </button>
              )}
              <InstallSteps os={os} />
              {os === "ios" && <p className="text-xs text-ink-3">Necesita iOS 16.4 o más reciente.</p>}
            </>
          )}
        </section>
      )}

      {sessions && (
        <section className="card overflow-hidden">
          <div className="border-b border-line px-5 py-4">
            <h2 className="text-sm font-semibold">Sesiones abiertas</h2>
            <p className="text-xs text-ink-3">Si se pierde un celular, cierra aquí su sesión: pide la contraseña otra vez y deja de recibir alertas.</p>
          </div>
          {sessions.map((s) => (
            <div key={s.id} className="flex items-center gap-3 border-b border-line px-5 py-3.5 last:border-0">
              <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-sunken text-ink-2">
                {s.installed ? <Smartphone size={17} /> : <Laptop size={17} />}
              </span>
              <div className="min-w-0 flex-1">
                <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm font-semibold">
                  <span className="truncate">{s.userName}</span>
                  <span className="font-normal text-ink-3">{s.device}</span>
                  {s.id === current && <span className="rounded-full bg-clapi-soft px-2 py-0.5 text-[11px] text-clapi-ink">Este equipo</span>}
                  {s.alerts && <span className="rounded-full bg-ok-soft px-2 py-0.5 text-[11px] text-ok">Alertas activas</span>}
                </p>
                <p className="text-xs text-ink-3">
                  {s.installed ? "App instalada" : "Navegador"} · usada {when(s.lastSeenAt)} · vence {when(s.expiresAt)}
                </p>
              </div>
              <button
                type="button"
                onClick={() => setClosing(s)}
                aria-label={`Cerrar la sesión de ${s.userName} en ${s.device}`}
                className="ease-ui flex h-9 shrink-0 items-center gap-1.5 rounded-xl px-3 text-xs font-semibold text-danger can-hover:hover:bg-danger/10"
              >
                <LogOut size={14} /> <span className="hidden sm:inline">Cerrar</span>
              </button>
            </div>
          ))}
        </section>
      )}

      {closing && (
        <ConfirmDialog
          title={closing.id === current ? "¿Cerrar la sesión de este equipo?" : `¿Cerrar la sesión de ${closing.userName}?`}
          points={[`${closing.device}, ${closing.installed ? "app instalada" : "navegador"}.`, "Tendrá que escribir la contraseña otra vez.", "Deja de recibir alertas en ese equipo."]}
          confirmLabel="Sí, cerrar"
          onConfirm={() => closeSession(closing)}
          onClose={() => setClosing(null)}
        />
      )}
    </div>
  );
}

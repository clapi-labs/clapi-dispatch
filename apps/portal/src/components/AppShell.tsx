"use client";

import { Bell, BellOff, Bot, LayoutGrid, LogOut, MapPinOff, MessagesSquare, Tags, Users, Wallet } from "lucide-react";
import Image from "next/image";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";

import logotipo from "@/assets/logotipo-clapi.svg";
import { useTrips } from "@/components/TripsProvider";
import { BRAND } from "@/lib/brand";

const NAV = [
  { href: "/viajes", label: "Despachos", short: "Despachos", icon: LayoutGrid },
  { href: "/conversaciones", label: "Conversaciones", short: "Chats", icon: MessagesSquare },
  { href: "/flota", label: "Flota", short: "Flota", icon: Users },
  { href: "/arqueo", label: "Finanzas", short: "Finanzas", icon: Wallet },
  { href: "/tarifas", label: "Tarifas", short: "Tarifas", icon: Tags },
  // Herramienta de computador (dibujar con el mouse): no va en la barra del celular.
  { href: "/zonas", label: "Zonas sin cobertura", short: "Zonas", icon: MapPinOff, desktopOnly: true },
];

/** `round` es la de la cabecera del celular: un avatar circular al lado de la campana. */
function ClientLogo({ round }: { round?: boolean }) {
  const box = round ? "h-9 w-9 rounded-full" : "h-8 w-8 rounded-xl";
  return (
    <span className={`flex shrink-0 items-center justify-center bg-client text-xs font-extrabold tracking-tight text-white ${box}`}>
      {BRAND.client.initials}
    </span>
  );
}

/** El logotipo oficial (blanco con el punto amarillo, hecho para fondo oscuro)
 *  con el nombre del producto debajo. `sm` es el de la cabecera del celular. */
function PlatformLogo({ size = "md" }: { size?: "md" | "sm" }) {
  const md = size === "md";
  return (
    <div className="shrink-0">
      <Image src={logotipo} alt={BRAND.platform.name} loading="eager" className={`w-auto ${md ? "h-8" : "h-6"}`} />
      <p className={`ml-0.5 font-semibold uppercase leading-none tracking-[0.2em] text-white/50 ${md ? "mt-1.5 text-[10px]" : "mt-1 text-[9px]"}`}>
        {BRAND.platform.product}
      </p>
    </div>
  );
}

/** Vive siempre sobre el azul noche del cascarón. `compact` deja solo la
 *  campana en pantallas angostas: en la cabecera del celular no cabe el texto. */
function SoundButton({ compact }: { compact?: boolean }) {
  const { soundOn, setSoundOn } = useTrips();
  const Icon = soundOn ? Bell : BellOff;
  return (
    <button
      type="button"
      onClick={() => setSoundOn(!soundOn)}
      aria-label={soundOn ? "Silenciar alertas" : "Activar alertas sonoras"}
      className={`ease-ui flex shrink-0 items-center gap-2 rounded-xl text-xs font-medium focus-visible:outline-gold ${
        compact ? "h-10 w-10 justify-center sm:w-auto sm:px-3" : "h-10 px-3"
      } ${soundOn ? "bg-white/10 text-white" : "text-white/50 hover:bg-white/5"}`}
    >
      <Icon size={16} />
      <span className={compact ? "hidden sm:inline" : ""}>{soundOn ? "Alertas activas" : "Silenciado"}</span>
    </button>
  );
}

/** El estado del bot, siempre a la vista: "En vivo" mientras el portal le llega
 *  al servidor. En el celular se va el robot para que quepa al lado de la campana. */
function LiveStatus({ compact }: { compact?: boolean }) {
  const { online } = useTrips();
  return (
    <span
      role="status"
      className={`flex h-10 shrink-0 items-center gap-2 rounded-xl text-xs font-semibold text-white ${compact ? "px-2.5" : "px-3"} ${
        online ? "bg-white/10" : "bg-danger/30"
      }`}
    >
      <Bot size={16} className={compact ? "hidden sm:block" : ""} />
      {online ? "En vivo" : "Sin conexión"}
      <span className={`h-2 w-2 rounded-full ${online ? "animate-live bg-ok" : "bg-danger"}`} />
    </span>
  );
}

/**
 * El cliente: al pie del riel, o su insignia en la cabecera del celular.
 * "Cerrar sesión" aparece al pasar el cursor o al tocarlo.
 */
function ClientMenu({ variant }: { variant: "rail" | "header" }) {
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  const rail = variant === "rail";
  const router = useRouter();

  async function logout() {
    await fetch("/api/auth/logout", { method: "POST" }).catch(() => null);
    router.replace("/login");
    router.refresh();
  }

  useEffect(() => {
    if (!open) return;
    const away = (e: PointerEvent) => {
      if (!box.current?.contains(e.target as Node)) setOpen(false);
    };
    const esc = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("pointerdown", away);
    window.addEventListener("keydown", esc);
    return () => {
      window.removeEventListener("pointerdown", away);
      window.removeEventListener("keydown", esc);
    };
  }, [open]);

  // Solo el mouse abre y cierra al pasar: en táctil el toque haría las dos cosas a la vez.
  const hover = (next: boolean) => (e: React.PointerEvent) => {
    if (e.pointerType === "mouse") setOpen(next);
  };

  return (
    <div ref={box} className="relative" onPointerEnter={hover(true)} onPointerLeave={hover(false)}>
      <button
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className={
          rail
            ? "ease-ui flex w-full items-center gap-3 rounded-2xl bg-white/5 p-2.5 text-left focus-visible:outline-gold can-hover:hover:bg-white/10"
            : "flex items-center gap-2 rounded-full focus-visible:outline-gold"
        }
      >
        {rail ? (
          <>
            <ClientLogo />
            <span className="min-w-0 truncate text-sm font-semibold">{BRAND.client.name}</span>
          </>
        ) : (
          <>
            {/* En celular solo va la insignia: el nombre se lee desde tableta. */}
            <span className="sr-only truncate text-sm font-semibold md:not-sr-only">{BRAND.client.name}</span>
            <ClientLogo round />
          </>
        )}
      </button>

      {open && (
        // Relleno y no margen entre el botón y el menú: el cursor cruza sin que el menú se cierre.
        <div className={`absolute z-50 ${rail ? "bottom-full left-0 right-0 pb-2" : "right-0 top-full w-56 pt-2"}`}>
          <div role="menu" className="rounded-2xl bg-surface p-1.5 text-ink shadow-xl ring-1 ring-line">
            {!rail && <p className="truncate px-3 pb-1.5 pt-1 text-xs font-semibold text-ink-3">{BRAND.client.name}</p>}
            <button
              type="button"
              role="menuitem"
              onClick={logout}
              className="ease-ui flex h-10 w-full items-center gap-2.5 rounded-xl px-3 text-sm font-medium text-danger can-hover:hover:bg-danger/10"
            >
              <LogOut size={16} /> Cerrar sesión
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

/** La burbuja amarilla de una sección: cuántas cosas esperan a alguien. */
function badgeFor(href: string, pending: number, needsHelp: number) {
  if (href === "/viajes") return pending;
  if (href === "/conversaciones") return needsHelp;
  return 0;
}

export function AppShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const { trips, needsHelp } = useTrips();
  const pending = trips.filter((t) => t.status === "pending").length;

  return (
    <div className="flex h-full">
      {/* Escritorio: riel lateral, el cascarón CLAPI. */}
      <aside className="hidden w-64 shrink-0 flex-col bg-clapi-deep px-5 py-6 text-white lg:flex">
        <div className="mb-12 px-1">
          <PlatformLogo />
        </div>

        <nav className="flex flex-col gap-3">
          {NAV.map(({ href, label, icon: Icon }) => {
            const active = pathname?.startsWith(href);
            const badge = badgeFor(href, pending, needsHelp);
            return (
              <Link
                key={href}
                href={href}
                className={`ease-ui flex h-11 items-center gap-3 rounded-xl px-3 text-sm font-medium focus-visible:outline-gold ${
                  active ? "bg-clapi text-white" : "text-white/60 hover:bg-white/5 hover:text-white"
                }`}
              >
                <Icon size={18} />
                {label}
                {badge > 0 && <span className="ml-auto rounded-full bg-gold px-2 py-0.5 text-[11px] font-bold text-clapi-deep">{badge}</span>}
              </Link>
            );
          })}
        </nav>

        {/* Abajo: el estado del bot, las alertas y, al pie, el cliente (con "Cerrar sesión"). */}
        <div className="mt-auto flex flex-col gap-3">
          <LiveStatus />
          <SoundButton />
          <ClientMenu variant="rail" />
        </div>
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        {/* Celular y tablet: cabecera compacta, en el mismo azul noche del riel. A la
            izquierda CLAPI; a la derecha el estado del bot, la campana y, al final, el cliente. */}
        <header className="flex items-center justify-between gap-3 bg-clapi-deep px-4 pb-3 pt-[calc(env(safe-area-inset-top)+0.75rem)] text-white lg:hidden">
          <PlatformLogo size="sm" />
          <div className="flex min-w-0 items-center gap-2">
            <LiveStatus compact />
            <SoundButton compact />
            <ClientMenu variant="header" />
          </div>
        </header>

        <main className="no-scrollbar min-h-0 flex-1 overflow-y-auto pb-tabbar lg:pb-0">{children}</main>

        {/* Celular y tablet: barra de navegación abajo, al alcance del pulgar. Es el riel
            del escritorio acostado: azul noche, y la sección activa en su cápsula violeta. */}
        <nav className="fixed inset-x-0 bottom-0 z-40 grid grid-cols-5 bg-clapi-deep/95 pb-[env(safe-area-inset-bottom)] text-white backdrop-blur lg:hidden">
          {NAV.filter((item) => !item.desktopOnly).map(({ href, short, icon: Icon }) => {
            const active = pathname?.startsWith(href);
            const badge = badgeFor(href, pending, needsHelp);
            return (
              <Link
                key={href}
                href={href}
                className={`flex h-16 flex-col items-center justify-center gap-1 text-[11px] font-medium focus-visible:outline-gold ${
                  active ? "text-white" : "text-white/60"
                }`}
              >
                <span className={`ease-ui relative flex h-8 w-14 items-center justify-center rounded-full ${active ? "bg-clapi" : ""}`}>
                  <Icon size={20} strokeWidth={active ? 2.4 : 2} />
                  {badge > 0 && (
                    <span className="absolute -top-1 right-0 min-w-[18px] rounded-full bg-gold px-1 text-center text-[10px] font-bold leading-[18px] text-clapi-deep">
                      {badge}
                    </span>
                  )}
                </span>
                {short}
              </Link>
            );
          })}
        </nav>
      </div>
    </div>
  );
}

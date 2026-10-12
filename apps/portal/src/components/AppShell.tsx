"use client";

import { Bell, BellOff, LayoutGrid, MessagesSquare, Tags, Users, Wallet } from "lucide-react";
import Image from "next/image";
import Link from "next/link";
import { usePathname } from "next/navigation";

import logotipo from "@/assets/logotipo-clapi.svg";
import { useTrips } from "@/components/TripsProvider";
import { BRAND } from "@/lib/brand";

const NAV = [
  { href: "/viajes", label: "Despachos", short: "Despachos", icon: LayoutGrid },
  { href: "/conversaciones", label: "Conversaciones", short: "Chats", icon: MessagesSquare },
  { href: "/flota", label: "Flota", short: "Flota", icon: Users },
  { href: "/arqueo", label: "Finanzas", short: "Finanzas", icon: Wallet },
  { href: "/tarifas", label: "Tarifas", short: "Tarifas", icon: Tags },
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

export function AppShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const { trips } = useTrips();
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
                {href === "/viajes" && pending > 0 && (
                  <span className="ml-auto rounded-full bg-gold px-2 py-0.5 text-[11px] font-bold text-clapi-deep">{pending}</span>
                )}
              </Link>
            );
          })}
        </nav>

        {/* Abajo: las alertas y, al pie, de quién es la central. */}
        <div className="mt-auto flex flex-col gap-3">
          <SoundButton />
          <div className="flex items-center gap-3 rounded-2xl bg-white/5 p-2.5">
            <ClientLogo />
            <div className="min-w-0 leading-tight">
              <p className="truncate text-sm font-semibold">{BRAND.client.name}</p>
              <p className="text-xs text-white/60">Central de despachos</p>
            </div>
          </div>
        </div>
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        {/* Celular y tablet: cabecera compacta, en el mismo azul noche del riel.
            A la izquierda CLAPI; a la derecha la campana y, al final, el cliente. */}
        <header className="flex items-center justify-between gap-3 bg-clapi-deep px-4 pb-3 pt-[calc(env(safe-area-inset-top)+0.75rem)] text-white lg:hidden">
          <PlatformLogo size="sm" />
          <div className="flex min-w-0 items-center gap-2">
            <SoundButton compact />
            {/* En celular solo va la insignia: el nombre se lee desde tableta. */}
            <p className="sr-only truncate text-sm font-semibold md:not-sr-only">{BRAND.client.name}</p>
            <ClientLogo round />
          </div>
        </header>

        <main className="no-scrollbar min-h-0 flex-1 overflow-y-auto pb-tabbar lg:pb-0">{children}</main>

        {/* Celular y tablet: barra de navegación abajo, al alcance del pulgar. Es el riel
            del escritorio acostado: azul noche, y la sección activa en su cápsula violeta. */}
        <nav className="fixed inset-x-0 bottom-0 z-40 grid grid-cols-5 bg-clapi-deep/95 pb-[env(safe-area-inset-bottom)] text-white backdrop-blur lg:hidden">
          {NAV.map(({ href, short, icon: Icon }) => {
            const active = pathname?.startsWith(href);
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
                  {href === "/viajes" && pending > 0 && (
                    <span className="absolute -top-1 right-0 min-w-[18px] rounded-full bg-gold px-1 text-center text-[10px] font-bold leading-[18px] text-clapi-deep">
                      {pending}
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

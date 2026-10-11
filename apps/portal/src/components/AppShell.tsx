"use client";

import { Bell, BellOff, LayoutGrid, MessagesSquare, Tags, Users, Wallet } from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";

import { useTrips } from "@/components/TripsProvider";
import { BRAND } from "@/lib/brand";

const NAV = [
  { href: "/viajes", label: "Despachos", short: "Despachos", icon: LayoutGrid },
  { href: "/conversaciones", label: "Conversaciones", short: "Chats", icon: MessagesSquare },
  { href: "/flota", label: "Flota", short: "Flota", icon: Users },
  { href: "/arqueo", label: "Finanzas", short: "Finanzas", icon: Wallet },
  { href: "/tarifas", label: "Tarifas", short: "Tarifas", icon: Tags },
];

function ClientLogo({ size = "md" }: { size?: "md" | "sm" }) {
  const box = size === "md" ? "h-10 w-10 text-sm" : "h-8 w-8 text-xs";
  return (
    <span className={`flex shrink-0 items-center justify-center rounded-xl bg-client font-extrabold tracking-tight text-white ${box}`}>
      {BRAND.client.initials}
    </span>
  );
}

function PoweredBy({ dark }: { dark?: boolean }) {
  return (
    <span className={`flex items-center gap-1.5 text-[11px] ${dark ? "text-white/50" : "text-ink-3"}`}>
      <span className="flex gap-0.5">
        <span className="h-1.5 w-1.5 rounded-full bg-clapi" />
        <span className="h-1.5 w-1.5 rounded-full bg-gold" />
      </span>
      con tecnología <strong className={dark ? "text-white/80" : "text-clapi-ink"}>CLAPI</strong>
    </span>
  );
}

function SoundButton({ dark }: { dark?: boolean }) {
  const { soundOn, setSoundOn } = useTrips();
  const Icon = soundOn ? Bell : BellOff;
  return (
    <button
      type="button"
      onClick={() => setSoundOn(!soundOn)}
      aria-label={soundOn ? "Silenciar alertas" : "Activar alertas sonoras"}
      className={`ease-ui flex h-10 items-center gap-2 rounded-xl px-3 text-xs font-medium ${
        dark
          ? soundOn
            ? "bg-white/10 text-white"
            : "text-white/50 hover:bg-white/5"
          : soundOn
            ? "bg-clapi-soft text-clapi-ink"
            : "bg-sunken text-ink-3"
      }`}
    >
      <Icon size={16} />
      <span className={dark ? "" : "hidden sm:inline"}>{soundOn ? "Alertas activas" : "Silenciado"}</span>
    </button>
  );
}

export function AppShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const { trips, online } = useTrips();
  const pending = trips.filter((t) => t.status === "pending").length;

  return (
    <div className="flex h-full">
      {/* Escritorio: riel lateral, el cascarón CLAPI. */}
      <aside className="hidden w-64 shrink-0 flex-col bg-clapi-deep px-4 py-5 text-white lg:flex">
        <div className="flex items-center gap-3 px-1">
          <ClientLogo />
          <div className="min-w-0 leading-tight">
            <p className="truncate font-semibold">{BRAND.client.name}</p>
            <p className="text-xs text-white/60">Central de despachos</p>
          </div>
        </div>

        <nav className="mt-8 flex flex-col gap-1">
          {NAV.map(({ href, label, icon: Icon }) => {
            const active = pathname?.startsWith(href);
            return (
              <Link
                key={href}
                href={href}
                className={`ease-ui relative flex h-11 items-center gap-3 rounded-xl px-3 text-sm font-medium ${
                  active ? "bg-white/10 text-white" : "text-white/60 hover:bg-white/5 hover:text-white"
                }`}
              >
                {active && <span className="absolute left-0 h-5 w-1 rounded-r-full bg-gold" />}
                <Icon size={18} />
                {label}
                {href === "/viajes" && pending > 0 && (
                  <span className="ml-auto rounded-full bg-gold px-2 py-0.5 text-[11px] font-bold text-clapi-deep">{pending}</span>
                )}
              </Link>
            );
          })}
        </nav>

        <div className="mt-auto flex flex-col gap-3">
          <SoundButton dark />
          <div className="flex items-center gap-2 px-1 text-xs text-white/60">
            <span className={`h-2 w-2 rounded-full ${online ? "animate-live bg-ok" : "bg-danger"}`} />
            {online ? "En vivo" : "Sin conexión"}
          </div>
          <div className="border-t border-white/10 px-1 pt-3">
            <PoweredBy dark />
          </div>
        </div>
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        {/* Celular y tablet: cabecera compacta. */}
        <header className="flex items-center gap-3 border-b border-line bg-surface px-4 pb-3 pt-[calc(env(safe-area-inset-top)+0.75rem)] lg:hidden">
          <ClientLogo size="sm" />
          <div className="min-w-0 flex-1 leading-tight">
            <p className="truncate text-sm font-semibold">{BRAND.client.name}</p>
            <PoweredBy />
          </div>
          <span className={`h-2 w-2 rounded-full ${online ? "animate-live bg-ok" : "bg-danger"}`} />
          <SoundButton />
        </header>

        <main className="no-scrollbar min-h-0 flex-1 overflow-y-auto pb-tabbar lg:pb-0">{children}</main>

        {/* Celular y tablet: barra de navegación abajo, al alcance del pulgar. */}
        <nav className="fixed inset-x-0 bottom-0 z-40 grid grid-cols-5 border-t border-line bg-surface/95 pb-[env(safe-area-inset-bottom)] backdrop-blur lg:hidden">
          {NAV.map(({ href, short, icon: Icon }) => {
            const active = pathname?.startsWith(href);
            return (
              <Link
                key={href}
                href={href}
                className={`relative flex h-16 flex-col items-center justify-center gap-1 text-[11px] font-medium ${
                  active ? "text-clapi-ink" : "text-ink-3"
                }`}
              >
                {active && <span className="absolute top-0 h-0.5 w-10 rounded-b-full bg-clapi" />}
                <span className="relative">
                  <Icon size={21} strokeWidth={active ? 2.4 : 2} />
                  {href === "/viajes" && pending > 0 && (
                    <span className="absolute -right-2.5 -top-1.5 min-w-[18px] rounded-full bg-gold px-1 text-center text-[10px] font-bold leading-[18px] text-clapi-deep">
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

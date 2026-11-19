"use client";

import { Link2, UserPlus, Users } from "lucide-react";
import { useCallback, useEffect, useState } from "react";

import { copyText } from "@/lib/clipboard";

type PortalUser = { id: number; email: string; name: string; active: boolean };

/**
 * «Usuarios del portal» (/salud): ver quién entra, crear un usuario y generar
 * el enlace de contraseña (24 h, un solo uso) para pasárselo por WhatsApp.
 */
export function PortalUsersCard() {
  const [users, setUsers] = useState<PortalUser[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [link, setLink] = useState<{ id: number; url: string } | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const res = await fetch("/api/portal-users", { cache: "no-store" }).catch(() => null);
    if (!res?.ok) {
      setError(res?.status === 403 ? "Solo para administradores (PORTAL_ADMIN_EMAILS)." : "No se pudo cargar la lista.");
      return;
    }
    setUsers(((await res.json()) as { users: PortalUser[] }).users);
    setError(null);
  }, []);

  useEffect(() => {
    const first = setTimeout(() => void load(), 0);
    return () => clearTimeout(first);
  }, [load]);

  async function generate(user: PortalUser) {
    setBusy(true);
    setNotice(null);
    const res = await fetch(`/api/portal-users/${user.id}/link`, { method: "POST" }).catch(() => null);
    setBusy(false);
    if (!res?.ok) {
      setError("No se pudo generar el enlace.");
      return;
    }
    const { url } = (await res.json()) as { url: string };
    setError(null);
    setLink({ id: user.id, url });
    setNotice((await copyText(url)) ? "Enlace copiado: válido 24 horas y de un solo uso." : "No se pudo copiar solo: cópialo de abajo.");
  }

  async function create(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const formEl = event.currentTarget;
    const form = new FormData(formEl);
    setBusy(true);
    setNotice(null);
    const res = await fetch("/api/portal-users", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ usuario: form.get("usuario"), nombre: form.get("nombre") }),
    }).catch(() => null);
    setBusy(false);
    const data = await res?.json().catch(() => ({}));
    if (!res?.ok) {
      setError(data?.error ?? "No se pudo crear el usuario.");
      return;
    }
    formEl.reset();
    setError(null);
    setNotice(`Usuario «${data.user.email}» creado. Genera su enlace de contraseña.`);
    await load();
  }

  const field = "h-10 min-w-0 flex-1 rounded-xl border border-line bg-surface px-3 text-sm text-ink outline-none focus-visible:border-clapi";

  return (
    <section className="card flex flex-col gap-3 p-5">
      <h2 className="flex items-center gap-2 text-sm font-semibold">
        <Users size={16} className="text-clapi-ink" />
        Usuarios del portal
      </h2>
      {error ? (
        <p role="alert" className="rounded-xl bg-danger-soft px-4 py-3 text-sm text-danger">
          {error}
        </p>
      ) : null}
      {notice ? (
        <p role="status" className="rounded-xl bg-ok-soft px-4 py-3 text-sm text-ok">
          {notice}
        </p>
      ) : null}
      <ul className="flex flex-col divide-y divide-line">
        {(users ?? []).map((u) => (
          <li key={u.id} className="flex flex-col gap-2 py-2.5">
            <div className="flex items-center justify-between gap-3 text-sm">
              <span className="min-w-0">
                <span className="block truncate font-medium">{u.name}</span>
                <span className="font-mono text-xs text-ink-3">
                  {u.email}
                  {u.active ? "" : " · desactivado"}
                </span>
              </span>
              {u.active ? (
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => void generate(u)}
                  className="flex h-9 shrink-0 items-center gap-1.5 rounded-xl bg-clapi-soft px-3 text-xs font-semibold text-clapi-ink disabled:opacity-50"
                >
                  <Link2 size={14} /> Generar enlace de contraseña
                </button>
              ) : null}
            </div>
            {link?.id === u.id ? (
              <input
                readOnly
                value={link.url}
                onFocus={(e) => e.currentTarget.select()}
                className="h-9 w-full rounded-lg border border-line bg-sunken px-2 font-mono text-[11px]"
                aria-label="Enlace de contraseña"
              />
            ) : null}
          </li>
        ))}
      </ul>
      <form onSubmit={create} className="flex flex-wrap items-center gap-2 border-t border-line pt-3">
        <input name="usuario" required placeholder="Usuario (Admin)" autoCapitalize="none" autoCorrect="off" className={field} />
        <input name="nombre" required placeholder="Nombre (William)" className={field} />
        <button type="submit" disabled={busy} className="flex h-10 items-center gap-1.5 rounded-xl bg-clapi px-3 text-xs font-semibold text-white disabled:opacity-60">
          <UserPlus size={14} /> Crear
        </button>
      </form>
      <p className="text-xs text-ink-3">El usuario nuevo entra solo cuando abre su enlace y escribe su contraseña.</p>
    </section>
  );
}

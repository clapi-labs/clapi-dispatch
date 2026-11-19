"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

import { MIN_PASSWORD_LENGTH } from "@/lib/password-link";

const field =
  "h-11 w-full rounded-xl border border-line bg-surface px-3 text-sm text-ink outline-none focus-visible:border-clapi focus-visible:ring-2 focus-visible:ring-clapi/30";

export function PasswordSetupForm({ token, userName, login }: { token: string; userName: string; login: string }) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    setBusy(true);
    setError(null);
    const res = await fetch("/api/auth/password-setup", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token, password: form.get("password"), confirm: form.get("confirm") }),
    }).catch(() => null);
    if (res?.ok) {
      router.replace("/login?clave=ok");
      return;
    }
    const data = await res?.json().catch(() => ({}));
    setError(data?.error ?? "No se pudo conectar. Intenta de nuevo.");
    setBusy(false);
  }

  return (
    <form onSubmit={submit} className="flex w-full max-w-sm flex-col gap-4 rounded-2xl bg-surface p-6 shadow-sm">
      <div>
        <h1 className="text-base font-semibold">Crea tu contraseña</h1>
        <p className="mt-1 text-sm text-ink-3">
          Usuario: <strong className="text-ink">{userName}</strong> <span className="font-mono text-xs">({login})</span>
        </p>
      </div>
      <input type="text" name="username" value={login} autoComplete="username" readOnly hidden />
      <label className="flex flex-col gap-1.5 text-sm font-medium text-ink-2">
        Nueva contraseña
        <input name="password" type="password" required minLength={MIN_PASSWORD_LENGTH} autoComplete="new-password" autoFocus className={field} />
      </label>
      <label className="flex flex-col gap-1.5 text-sm font-medium text-ink-2">
        Confirmar contraseña
        <input name="confirm" type="password" required minLength={MIN_PASSWORD_LENGTH} autoComplete="new-password" className={field} />
      </label>
      <p className="text-xs text-ink-3">Mínimo {MIN_PASSWORD_LENGTH} caracteres. Este enlace solo se puede usar una vez.</p>
      {error && (
        <p role="alert" className="rounded-lg bg-danger-soft px-3 py-2 text-sm text-danger">
          {error}
        </p>
      )}
      <button type="submit" disabled={busy} className="h-11 rounded-xl bg-clapi text-sm font-semibold text-white focus-visible:outline-gold disabled:opacity-60">
        {busy ? "Guardando…" : "Guardar contraseña"}
      </button>
    </form>
  );
}

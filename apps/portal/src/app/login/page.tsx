"use client";

import Image from "next/image";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useState } from "react";

import logotipo from "@/assets/logotipo-clapi.svg";
import { BRAND } from "@/lib/brand";

function LoginForm() {
  const router = useRouter();
  const params = useSearchParams();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    setBusy(true);
    setError(null);
    const res = await fetch("/api/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: form.get("email"), password: form.get("password") }),
    }).catch(() => null);
    if (res?.ok) {
      // Solo rutas internas: `next` no puede mandar a otro sitio.
      const next = params.get("next");
      router.replace(next && next.startsWith("/") && !next.startsWith("//") ? next : "/viajes");
      router.refresh();
      return;
    }
    const data = await res?.json().catch(() => ({}));
    setError(data?.error ?? "No se pudo conectar. Intenta de nuevo.");
    setBusy(false);
  }

  const field =
    "h-11 w-full rounded-xl border border-line bg-surface px-3 text-sm text-ink outline-none focus-visible:border-clapi focus-visible:ring-2 focus-visible:ring-clapi/30";

  return (
    <form onSubmit={submit} className="flex w-full max-w-sm flex-col gap-4 rounded-2xl bg-surface p-6 shadow-sm">
      <div className="mb-2 flex flex-col items-center gap-2 rounded-xl bg-clapi-deep px-4 py-5">
        <Image src={logotipo} alt={BRAND.platform.name} loading="eager" className="h-8 w-auto" />
        <p className="text-[10px] font-semibold uppercase tracking-[0.2em] text-white/50">{BRAND.platform.product}</p>
      </div>
      <label className="flex flex-col gap-1.5 text-sm font-medium text-ink-2">
        Correo
        <input name="email" type="email" required autoComplete="username" autoFocus className={field} />
      </label>
      <label className="flex flex-col gap-1.5 text-sm font-medium text-ink-2">
        Contraseña
        <input name="password" type="password" required autoComplete="current-password" className={field} />
      </label>
      {error && (
        <p role="alert" className="rounded-lg bg-danger-soft px-3 py-2 text-sm text-danger">
          {error}
        </p>
      )}
      <button
        type="submit"
        disabled={busy}
        className="h-11 rounded-xl bg-clapi text-sm font-semibold text-white focus-visible:outline-gold disabled:opacity-60"
      >
        {busy ? "Entrando…" : "Entrar"}
      </button>
    </form>
  );
}

export default function LoginPage() {
  return (
    <main className="flex min-h-full items-center justify-center bg-canvas px-4 py-10">
      <Suspense>
        <LoginForm />
      </Suspense>
    </main>
  );
}

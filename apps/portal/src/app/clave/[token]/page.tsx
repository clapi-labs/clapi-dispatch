import { userForPasswordLink } from "@/db/queries/password-link";

import { PasswordSetupForm } from "./PasswordSetupForm";

export const dynamic = "force-dynamic";

/** Página pública: crear o cambiar la contraseña con un enlace de un solo uso. */
export default async function ClavePage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const user = await userForPasswordLink(token);
  return (
    <main className="flex min-h-full items-center justify-center bg-canvas px-4 py-10">
      {user ? (
        <PasswordSetupForm token={token} userName={user.name} login={user.email} />
      ) : (
        <p role="alert" className="w-full max-w-sm rounded-2xl bg-surface p-6 text-center text-sm text-ink shadow-sm">
          Este enlace ya fue utilizado o expiró. Pídele uno nuevo al administrador.
        </p>
      )}
    </main>
  );
}

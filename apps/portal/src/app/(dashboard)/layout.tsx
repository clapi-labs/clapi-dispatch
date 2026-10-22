import { cookies } from "next/headers";
import { redirect } from "next/navigation";

import { AppShell } from "@/components/AppShell";
import { TripsProvider } from "@/components/TripsProvider";
import { SESSION_COOKIE, verifySessionToken } from "@/lib/session";

export default async function DashboardLayout({ children }: { children: React.ReactNode }) {
  // Segunda barrera además de proxy.ts: ninguna página del tablero se
  // renderiza sin sesión válida.
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  if (verifySessionToken(token) === null) redirect("/login");

  return (
    <TripsProvider>
      <AppShell>{children}</AppShell>
    </TripsProvider>
  );
}

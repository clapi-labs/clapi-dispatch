import { cookies } from "next/headers";
import { redirect } from "next/navigation";

import { simulatorEnabled } from "@dispatch/shared/db";

import { AppShell } from "@/components/AppShell";
import { TripsProvider } from "@/components/TripsProvider";
import { authDisabled, SESSION_COOKIE, verifySessionToken } from "@/lib/session";

export default async function DashboardLayout({ children }: { children: React.ReactNode }) {
  // Segunda barrera además de proxy.ts: ninguna página del tablero se
  // renderiza sin sesión válida.
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  if (!authDisabled() && verifySessionToken(token) === null) redirect("/login");

  return (
    <TripsProvider>
      <AppShell simulator={simulatorEnabled()}>{children}</AppShell>
    </TripsProvider>
  );
}

import { redirect } from "next/navigation";

import { simulatorEnabled } from "@dispatch/shared/db";

import { AppBridge } from "@/components/AppBridge";
import { AppShell } from "@/components/AppShell";
import { TripsProvider } from "@/components/TripsProvider";
import { currentSession } from "@/lib/auth";
import { authDisabled } from "@/lib/session";

export default async function DashboardLayout({ children }: { children: React.ReactNode }) {
  // Segunda barrera además de proxy.ts: ninguna página del tablero se
  // renderiza sin sesión válida.
  if (!authDisabled() && (await currentSession()) === null) redirect("/login");

  return (
    <TripsProvider>
      <AppBridge />
      <AppShell simulator={simulatorEnabled()}>{children}</AppShell>
    </TripsProvider>
  );
}

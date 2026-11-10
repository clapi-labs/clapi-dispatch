import { notFound, redirect } from "next/navigation";

import { simulatorEnabled } from "@dispatch/shared/db";

import { SimulatorMap } from "@/components/SimulatorMap";
import { currentSession } from "@/lib/auth";

export const dynamic = "force-dynamic";
export const metadata = { title: "Simulador" };

/**
 * El mapa del simulador de staging (docs/OPERACION.md, «Simulador»). Sin
 * `SIMULATOR_ENABLED` no existe, y siempre pide sesión, aunque el login esté
 * apagado: desde aquí se crean pedidos y se reinicia lo simulado.
 */
export default async function SimuladorPage() {
  if (!simulatorEnabled()) notFound();
  if ((await currentSession()) === null) redirect("/login?next=/simulador");
  return <SimulatorMap />;
}

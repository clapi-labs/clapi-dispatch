import { cookies } from "next/headers";
import { notFound, redirect } from "next/navigation";

import { simulatorEnabled } from "@dispatch/shared/db";

import { SimulatorMap } from "@/components/SimulatorMap";
import { SESSION_COOKIE, verifySessionToken } from "@/lib/session";

export const dynamic = "force-dynamic";
export const metadata = { title: "Simulador" };

/**
 * El mapa del simulador de staging (docs/OPERACION.md, «Simulador»). Sin
 * `SIMULATOR_ENABLED` no existe, y siempre pide sesión, aunque el login esté
 * apagado: desde aquí se crean pedidos y se reinicia lo simulado.
 */
export default async function SimuladorPage() {
  if (!simulatorEnabled()) notFound();
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  if (verifySessionToken(token) === null) redirect("/login?next=/simulador");
  return <SimulatorMap />;
}

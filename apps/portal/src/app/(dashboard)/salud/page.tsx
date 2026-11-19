import { redirect } from "next/navigation";

import { isAdmin } from "@/lib/admin";

import { SystemHealthView } from "./SystemHealthView";

export const dynamic = "force-dynamic";

/** Solo administradores (`lib/admin.ts`); los demás vuelven al tablero. */
export default async function SaludPage() {
  if (!(await isAdmin())) redirect("/viajes");
  return <SystemHealthView />;
}

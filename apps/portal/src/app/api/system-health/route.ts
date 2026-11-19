import { systemHealth } from "@dispatch/shared/db";

import { isAdmin } from "@/lib/admin";

export const dynamic = "force-dynamic";

/** «Salud del sistema» (/salud): disco, base, imágenes y memoria. Solo para
 *  administradores (`lib/admin.ts`). */
export async function GET() {
  if (!(await isAdmin())) return Response.json({ error: "Solo administradores" }, { status: 403 });
  return Response.json(await systemHealth());
}

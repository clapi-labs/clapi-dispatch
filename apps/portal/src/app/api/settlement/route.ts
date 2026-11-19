import { getSettlement } from "@/db/queries/settlement";
import { parseYmd, weekStart } from "@/lib/week";

export const dynamic = "force-dynamic";

/**
 * Sin parámetros: el cierre de hoy. `?semana=YYYY-MM-DD` (cualquier fecha de la
 * semana): el acumulado lunes–domingo y el resumen de cada día. `&dia=YYYY-MM-DD`
 * (dentro de esa semana): el detalle de ese día. Solo `?dia=` toma su semana.
 */
export async function GET(request?: Request) {
  const params = request ? new URL(request.url).searchParams : new URLSearchParams();
  const semana = params.get("semana") ?? undefined;
  const dia = params.get("dia") ?? undefined;

  if (semana !== undefined && !parseYmd(semana)) return Response.json({ error: "«semana» debe ser una fecha AAAA-MM-DD válida" }, { status: 400 });
  if (dia !== undefined && !parseYmd(dia)) return Response.json({ error: "«dia» debe ser una fecha AAAA-MM-DD válida" }, { status: 400 });
  if (semana && dia && weekStart(semana) !== weekStart(dia)) return Response.json({ error: "«dia» no está en la semana pedida" }, { status: 400 });

  return Response.json(await getSettlement({ semana, dia }));
}

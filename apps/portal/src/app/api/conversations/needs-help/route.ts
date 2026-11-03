import { countNeedingHelp } from "@/db/queries/conversations";

export const dynamic = "force-dynamic";

/** Solo el número: lo consulta la navegación en cada sondeo, desde cualquier pantalla. */
export async function GET() {
  return Response.json({ count: await countNeedingHelp() });
}

import { idsNeedingHelp } from "@/db/queries/conversations";

export const dynamic = "force-dynamic";

/** Qué chats piden ayuda (y cuántos): lo consulta la navegación en cada sondeo, desde cualquier pantalla. */
export async function GET() {
  const ids = await idsNeedingHelp();
  return Response.json({ count: ids.length, ids });
}

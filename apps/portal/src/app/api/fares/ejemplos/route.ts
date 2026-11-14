import { fareExampleDistances } from "@dispatch/shared/db";

export const dynamic = "force-dynamic";

/**
 * Los km de la tabla de ejemplos de Tarifas (`fareExampleDistances`): de los
 * restaurantes de cada zona al centro de cada zona, medidos como los mide el
 * bot. Sin precios: el portal los calcula con la tabla que se está editando,
 * antes de guardar. `?medida=calle`: por calle aunque el interruptor esté
 * apagado (vista previa de la tarifa nueva).
 */
export async function GET(request: Request) {
  const previewStreet = new URL(request.url).searchParams.get("medida") === "calle";
  return Response.json(await fareExampleDistances({ previewStreet }));
}

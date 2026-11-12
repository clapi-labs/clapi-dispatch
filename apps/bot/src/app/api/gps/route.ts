import { positionTime } from "@dispatch/shared";

import { courierForDevice, recordPosition } from "@/bot/gps";
import { readReport } from "@/bot/gps-report";

export const dynamic = "force-dynamic";

/** Una posición con más error que esto no sirve para saber si llegó. */
const MAX_ACCURACY_M = 100;

/**
 * Recibe la ubicación de los motorizados. Es pública porque le escriben sus
 * celulares: el identificador aleatorio de cada uno es lo que autoriza, y los que
 * no se conocen se descartan. Se responde 200 a lo que no sirve: si no, Traccar
 * reintenta para siempre un reporte que nunca va a servir.
 */
async function handle(request: Request) {
  const report = await readReport(request);
  const valid = report.id && Math.abs(report.lat) <= 90 && Math.abs(report.lng) <= 180;
  if (!valid) return new Response("OK", { status: 200 });

  const courier = await courierForDevice(report.id!);
  if (!courier) return new Response("OK", { status: 200 });

  if (report.accuracy === null || report.accuracy <= MAX_ACCURACY_M) {
    // Hora del servidor si el reloj del celular está cerca: un celular atrasado
    // no puede contar como sin señal, ni uno adelantado dejar la moto «en vivo».
    const at = positionTime(report.at, new Date());
    await recordPosition(courier.id, { lat: report.lat, lng: report.lng }, at);
  }
  return new Response("OK", { status: 200 });
}

export const GET = handle;
export const POST = handle;

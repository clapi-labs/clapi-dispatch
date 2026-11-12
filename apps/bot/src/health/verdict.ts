/**
 * Si el sistema está sano (docs/OPERACION.md, «Avisos»). Lo consulta desde
 * afuera el servicio de monitoreo por `/api/health`, que avisa al grupo de
 * Telegram si responde «no ok». Pura: sin red ni base, para probarla sola.
 *
 * No está sano si:
 * - falta configuración (variables de entorno);
 * - la base de datos no contesta;
 * - el worker lleva más de `WORKER_STALE_MS` sin completar una vuelta: la
 *   asignación, los avisos y los recordatorios se detuvieron;
 * - el engine no responde mientras asigna de verdad (modo `auto`). En `queue` o
 *   `shadow` asigna la cola, así que el engine caído no detiene nada.
 */

/** El worker da una vuelta cada 5 segundos. Un despliegue lo reinicia en menos
 *  de un minuto: 2 minutos sin vueltas ya es que se detuvo. */
export const WORKER_STALE_MS = 2 * 60_000;

export type HealthInput = {
  now: Date;
  /** Variables de entorno que faltan. */
  missingEnv: string[];
  /** Si la base contestó. Sin base, lo del worker y el engine no se puede saber. */
  database: boolean;
  /** Cuándo terminó el worker su última vuelta (`null`: nunca). */
  lastTickAt: Date | null;
  /** `off`: no se revisa (no está en modo auto). */
  engine: "off" | "ok" | "down";
};

/** Lo que falla, en palabras, para los registros. Vacío: está sano. */
export function healthProblems(input: HealthInput): string[] {
  const problems: string[] = [];
  if (input.missingEnv.length) problems.push(`faltan variables: ${input.missingEnv.join(", ")}`);
  if (!input.database) {
    problems.push("la base de datos no contesta");
    return problems;
  }
  if (!input.lastTickAt) problems.push("el worker nunca ha completado una vuelta");
  else {
    const seconds = Math.round((input.now.getTime() - input.lastTickAt.getTime()) / 1000);
    if (seconds * 1000 > WORKER_STALE_MS) problems.push(`el worker lleva ${seconds} s sin completar una vuelta`);
  }
  if (input.engine === "down") problems.push("el engine no responde y está en modo auto");
  return problems;
}

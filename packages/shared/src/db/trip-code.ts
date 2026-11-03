import { sql } from "drizzle-orm";

import { db } from "./client";

/**
 * El código de un pedido: una letra y dos cifras, como `B-12`.
 *
 * El contador sube las cifras de 00 a 99 y, al pasar de 99, cambia de letra y
 * vuelve a 00: A-00 … A-99, B-00 … B-99, … Z-99, y de ahí otra vez A-00. Son
 * 2.600 códigos por vuelta; lo lleva la secuencia cíclica `trip_code_seq`
 * (0 a 2599). Un código se repite cada 2.600 pedidos, así que no identifica un
 * pedido para siempre: cuando el restaurante lo nombra se busca el más
 * reciente de su conversación.
 */

export const TRIP_CODE_LETTERS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
export const TRIP_CODES_PER_CYCLE = TRIP_CODE_LETTERS.length * 100;

/** El código del valor `n` del contador: 0 → A-00, 99 → A-99, 100 → B-00. */
export function formatTripCode(n: number): string {
  const index = ((Math.trunc(n) % TRIP_CODES_PER_CYCLE) + TRIP_CODES_PER_CYCLE) % TRIP_CODES_PER_CYCLE;
  return `${TRIP_CODE_LETTERS[Math.floor(index / 100)]}-${String(index % 100).padStart(2, "0")}`;
}

/** El siguiente código, con el valor de la secuencia `trip_code_seq`. */
export async function nextTripCode(): Promise<string> {
  const result = (await db.execute(sql`select nextval('trip_code_seq')::int as n`)) as unknown as
    | { rows?: { n: number }[] }
    | { n: number }[];
  const rows = Array.isArray(result) ? result : (result.rows ?? []);
  return formatTripCode(Number(rows[0].n));
}

/**
 * Los códigos de pedido que menciona un texto, ya normalizados: «¿ya llegó el
 * B-12?», «el b12 ya está listo», «pedido B 12», «#B12» → `B-12`.
 *
 * Letra y cifras van pegadas o con guion; con un espacio solo cuentan después
 * de «pedido» o «#», porque «a 20 minutos» o «y 15» no son códigos. También
 * reconoce los códigos del formato anterior (`B1005`) de los pedidos viejos.
 * Quien llama confirma que el pedido exista y sea de esa conversación.
 */
export function tripCodesInText(text: string): string[] {
  const found = new Set<string>();
  const add = (letter: string, digits: string) =>
    found.add(digits.length === 2 ? `${letter.toUpperCase()}-${digits}` : `${letter.toUpperCase()}${digits}`);

  const patterns = [
    /(?<![\p{L}\d])([a-z])-?(\d{2}|\d{4,6})(?![\p{L}\d])/giu,
    /(?:#|pedido\s+(?:n[°º.o]?\s*)?#?)\s*([a-z])\s*-?\s*(\d{2}|\d{4,6})(?![\p{L}\d])/giu,
  ];
  for (const pattern of patterns) for (const match of text.matchAll(pattern)) add(match[1], match[2]);
  return [...found];
}

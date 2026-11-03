import { sql } from "drizzle-orm";

import { db } from "./client";

/**
 * El código de un pedido: una letra por día de la semana y un número global
 * que nunca se repite. `A1042` es el pedido 1042, hecho un lunes.
 *
 * El número basta para identificarlo (es único); la letra ayuda a ubicarlo a
 * simple vista: A lunes, B martes, C miércoles, D jueves, E viernes, F sábado
 * y G domingo, en hora de Colombia. Así lo dicen el restaurante, el
 * motorizado y la central sin confundirse.
 */

const DAY_LETTER: Record<string, string> = { Mon: "A", Tue: "B", Wed: "C", Thu: "D", Fri: "E", Sat: "F", Sun: "G" };

export const TRIP_CODE_LETTERS = "ABCDEFG";

/** La letra del día en Colombia. */
export function dayLetter(at: Date = new Date()): string {
  const weekday = new Intl.DateTimeFormat("en-US", { weekday: "short", timeZone: "America/Bogota" }).format(at);
  return DAY_LETTER[weekday] ?? "A";
}

export function formatTripCode(number: number, at: Date = new Date()): string {
  return `${dayLetter(at)}${number}`;
}

/** El siguiente código, con el número de la secuencia `trip_code_seq`. */
export async function nextTripCode(at: Date = new Date()): Promise<string> {
  const result = (await db.execute(sql`select nextval('trip_code_seq')::int as n`)) as unknown as { rows?: { n: number }[] } | { n: number }[];
  const rows = Array.isArray(result) ? result : (result.rows ?? []);
  return formatTripCode(Number(rows[0].n), at);
}

/**
 * Los números de pedido que menciona un texto: «¿ya llegó el A1042?»,
 * «el b1043 ya está listo», «pedido 1042», «#1042». Una cifra suelta no
 * cuenta (podría ser una dirección o un valor): tiene que ir con la letra,
 * con «#» o después de «pedido». Quien llama confirma que el pedido exista y
 * sea de esa conversación.
 */
export function tripNumbersInText(text: string): number[] {
  const found = new Set<number>();
  const patterns = [
    new RegExp(`(?<![\\p{L}\\d])[${TRIP_CODE_LETTERS}]\\s?-?(\\d{4,6})(?!\\d)`, "giu"),
    /#\s?(\d{4,6})(?!\d)/g,
    /pedido\s+(?:n[°º.o]?\s*)?#?\s?(\d{4,6})(?!\d)/giu,
  ];
  for (const pattern of patterns) for (const match of text.matchAll(pattern)) found.add(Number(match[1]));
  return [...found];
}

/** Los códigos posibles para un número (uno por letra del día). */
export function codesForNumber(number: number): string[] {
  return [...TRIP_CODE_LETTERS].map((letter) => `${letter}${number}`);
}

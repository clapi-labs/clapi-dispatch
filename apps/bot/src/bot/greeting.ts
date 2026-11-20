/**
 * Cómo se presenta el bot con los restaurantes (issue #121):
 *
 * - **El saludo del día.** La primera respuesta del día a un restaurante va
 *   encabezada por «¡Buenos días! / ¡Buenas tardes! / ¡Buenas noches! Gracias
 *   por confiar en Express Cali 🙌», en el mismo mensaje. Las siguientes no:
 *   saludar en cada mensaje se ve artificial. El día es el de Cali.
 * - **Un saludo suelto** («hola», «buenas tardes») se responde preguntando para
 *   dónde es el servicio, sin pasar por OpenAI, sin sumar intentos y sin pasar
 *   el chat a la central.
 * - **«¿Quién eres?»** se responde con la presentación de Clapi Solutions.
 *   Solo si lo preguntan.
 *
 * Todo es puro (sin red ni base) para poder probarlo solo.
 */

const CALI = "America/Bogota";
/** Cali no cambia de hora en el año: siempre UTC−5. */
const CALI_OFFSET = "-05:00";

export const IDENTITY_TEXT =
  "Soy un asistente implementado por Clapi Solutions, una empresa líder en automatizaciones que ayuda a Express Cali a mejorar sus flujos y tiempos de trabajo, agilizando la toma de servicios y brindando la mejor atención posible.";
export const IDENTITY_QUESTION = "¿En qué te puedo colaborar hoy?";
export const ASK_DESTINATION = "¿Para dónde necesitas el servicio hoy? 🛵";

/** La fecha (AAAA-MM-DD) y la hora (0–23) en Cali. */
function caliClock(now: Date): { date: string; hour: number } {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: CALI, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", hourCycle: "h23" }).formatToParts(now);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
  return { date: `${get("year")}-${get("month")}-${get("day")}`, hour: Number(get("hour")) };
}

/** La medianoche de hoy en Cali: desde ahí cuenta «el mismo día». */
export function startOfCaliDay(now: Date): Date {
  return new Date(`${caliClock(now).date}T00:00:00${CALI_OFFSET}`);
}

/** Mañana hasta las 11:59, tarde hasta las 18:59, noche desde las 19:00. */
export function dayGreeting(now: Date): string {
  const { hour } = caliClock(now);
  const part = hour < 12 ? "¡Buenos días!" : hour < 19 ? "¡Buenas tardes!" : "¡Buenas noches!";
  return `${part} Gracias por confiar en Express Cali 🙌`;
}

/** ¿Es la primera respuesta del día? Sí, si nadie de nuestro lado (bot o
 *  central) le ha escrito desde la medianoche de Cali. */
export function firstOfDay(lastOutgoingAt: Date | null, now: Date): boolean {
  return !lastOutgoingAt || lastOutgoingAt < startOfCaliDay(now);
}

/** Minúsculas, sin tildes, sin emojis ni signos: para comparar frases cortas. */
function plain(text: string): string {
  return text
    .toLowerCase()
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// Las palabras de un saludo. Un mensaje que solo tiene estas no pide nada.
const GREETING_WORDS = new Set([
  "hola", "holi", "holis", "ola", "buenas", "buenos", "buena", "buen", "dias", "dia", "tardes", "tarde", "noches", "noche",
  "saludos", "saludo", "que", "mas", "hey", "alo", "como", "esta", "estas", "va", "todo", "bien", "bendiciones",
  "feliz", "senor", "senora", "senores", "amigo", "amiga", "veci", "vecino", "vecina", "parce", "don", "dona", "y", "a", "pues", "muy",
]);
// Al menos una de estas: «todo bien» solo no es un saludo.
const GREETING_KEYS = /\b(hola|holi|holis|ola|buenas|buenos|buena|buen|saludos|hey|alo|que mas|bendiciones)\b/;

/** «Hola», «buenas tardes», «buenos días, ¿cómo va?»: un saludo sin nada más. */
export function isBareGreeting(text: string): boolean {
  // «holaaa», «buenaaas»: las letras alargadas cuentan como una.
  const words = plain(text).replace(/(\p{L})\1+/gu, "$1");
  if (!words || words.length > 60) return false;
  return GREETING_KEYS.test(words) && words.split(" ").every((w) => GREETING_WORDS.has(w));
}

// Las formas de preguntar con quién se habla.
const WHO_PATTERNS = [
  /\bquien (eres|es usted|sos|habla|me (habla|escribe|responde|contesta)|esta (hablando|escribiendo|respondiendo))\b/,
  /\bcon quien (hablo|estoy hablando|me comunico|tengo el gusto|tengo el placer)\b/,
  /\b(eres|usted es|sos) (un |una )?(bot|robot|maquina|asistente|ia|inteligencia artificial|persona real|humano|humana|persona)\b/,
  // «es un bot?» solo al empezar: «el cliente es una persona mayor» no pregunta nada.
  /^(es|esto es) (un |una )?(bot|robot|maquina|asistente|ia)\b/,
  /\b(hablo|hablando|escribiendo) con (un |una )?(bot|robot|maquina|asistente|ia|persona real|humano|humana)\b/,
  /\bque (es esto|eres|es este numero|numero es este)\b/,
];

/** ¿Pregunta quién es, con quién habla o si es un bot? */
export function asksWhoIAm(text: string): boolean {
  const words = plain(text);
  return WHO_PATTERNS.some((p) => p.test(words));
}

/**
 * Lo que queda del mensaje sin la pregunta de quién es y sin el saludo: si no
 * queda nada, el mensaje solo preguntaba eso y no hay pedido que seguir.
 */
export function onlyAsksWhoIAm(text: string): boolean {
  let rest = plain(text);
  for (const p of WHO_PATTERNS) rest = rest.replace(new RegExp(p.source, "g"), " ");
  rest = rest.replace(/\s+/g, " ").trim();
  return !rest || isBareGreeting(rest) || rest.split(" ").every((w) => GREETING_WORDS.has(w) || ["perdon", "disculpa", "oye", "oiga", "pregunta", "una", "duda"].includes(w));
}

/** El saludo va encima de la respuesta, separado por una línea. */
export function withGreeting(greeting: string | null, text: string): string {
  return greeting ? `${greeting}\n\n${text}` : text;
}

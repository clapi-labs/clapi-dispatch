export function formatCOP(value: number): string {
  return new Intl.NumberFormat("es-CO", {
    style: "currency",
    currency: "COP",
    maximumFractionDigits: 0,
  }).format(value);
}

/** Solo dígitos y siempre con indicativo: a un celular guardado como
 *  "300 123 4567" se le pone el 57 de Colombia. Es lo que esperan los enlaces
 *  de WhatsApp y `tel:`. */
export function phoneDigits(phone: string): string {
  const digits = phone.replace(/\D/g, "");
  return digits.length <= 10 ? `57${digits}` : digits;
}

/** Dos teléfonos son el mismo si coinciden sus últimos diez dígitos: con o sin el 57. */
export function samePhone(a: string, b: string): boolean {
  const tail = (phone: string) => phone.replace(/\D/g, "").slice(-10);
  return tail(a) === tail(b);
}

export function formatPhone(phone: string): string {
  const digits = phoneDigits(phone);
  if (digits.length === 12 && digits.startsWith("57")) {
    return `+57 ${digits.slice(2, 5)} ${digits.slice(5, 8)} ${digits.slice(8)}`;
  }
  return phone;
}

/**
 * Los teléfonos que aparecen dentro de un texto libre ("Numero cliente: 300 123 4567"),
 * sin repetir y ya como los deja `phoneDigits`. Celulares (3xx) y fijos (60x)
 * de Colombia: diez dígitos, con o sin el 57 delante.
 */
export function findPhones(text: string): string[] {
  const found = text.matchAll(/(?:^|\D)((?:\+?57[\s.-]?)?(?:3\d{2}|60\d)[\s.-]?\d{3}[\s.-]?\d{4})(?!\d)/g);
  return [...new Set([...found].map((match) => phoneDigits(match[1])))];
}

/** "45s", "2 min", "1 h 5 min" — una duración en palabras. */
export function durationLabel(totalSeconds: number): string {
  const seconds = Math.max(0, Math.floor(totalSeconds));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  return `${hours} h ${minutes % 60} min`;
}

/** "hace 2 min", "hace 1 h" — para el indicador de espera de la comanda. */
export function elapsedLabel(since: Date, now: Date = new Date()): string {
  return durationLabel((now.getTime() - since.getTime()) / 1000);
}

export function initials(name: string): string {
  return name
    .trim()
    .split(/\s+/)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase() ?? "")
    .join("");
}

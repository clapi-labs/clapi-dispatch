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

export function formatPhone(phone: string): string {
  const digits = phoneDigits(phone);
  if (digits.length === 12 && digits.startsWith("57")) {
    return `+57 ${digits.slice(2, 5)} ${digits.slice(5, 8)} ${digits.slice(8)}`;
  }
  return phone;
}

/** "hace 2 min", "hace 1 h" — para el indicador de espera de la comanda. */
export function elapsedLabel(since: Date, now: Date = new Date()): string {
  const seconds = Math.max(0, Math.floor((now.getTime() - since.getTime()) / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  return `${hours} h ${minutes % 60} min`;
}

export function initials(name: string): string {
  return name
    .trim()
    .split(/\s+/)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase() ?? "")
    .join("");
}

import type { Settlement } from "@/lib/types";
import { bogotaDate, DAY_NAMES_LONG, longDate, parseYmd, shortDate } from "@/lib/week";

/**
 * El mini reporte semanal de Finanzas en PDF, armado a mano: una página A4,
 * tipografías estándar del PDF (Helvetica, sin incrustar nada), sin librerías,
 * sin CDNs y sin pedir nada a la red. Se genera en el navegador y se descarga
 * como archivo, así que sirve igual en el escritorio y en el celular.
 */

const PAGE_W = 595;
const PAGE_H = 842;
const MARGIN = 48;
const MAX_COURIER_ROWS = 22;

/** Pesos: `$ 1.234.567`. Se arma a mano para no depender del `Intl` del dispositivo. */
export function pdfMoney(value: number): string {
  const digits = String(Math.abs(Math.round(value))).replace(/\B(?=(\d{3})+(?!\d))/g, ".");
  return `${value < 0 ? "-" : ""}$ ${digits}`;
}

/** Texto a bytes WinAnsi (Latin-1 + guiones largos); lo que no cabe, «?». */
function encode(text: string): number[] {
  const out: number[] = [];
  for (const ch of text) {
    const code = ch.codePointAt(0)!;
    if (ch === "–") out.push(0x96);
    else if (ch === "—") out.push(0x97);
    else if (code < 256) out.push(code);
    else out.push(0x3f);
  }
  return out;
}

function escapeBytes(bytes: number[]): number[] {
  const out: number[] = [];
  for (const b of bytes) {
    if (b === 0x5c || b === 0x28 || b === 0x29) out.push(0x5c);
    out.push(b);
  }
  return out;
}

/** Ancho aproximado en puntos de un texto de cifras y separadores (para alinear a la derecha). */
function numericWidth(text: string, size: number): number {
  let units = 0;
  for (const ch of text) units += /\d|\$/.test(ch) ? 556 : ch === "-" ? 333 : 278;
  return (units * size) / 1000;
}

class Page {
  private chunks: number[][] = [];

  private push(text: string) {
    this.chunks.push(encode(text));
  }

  text(x: number, y: number, value: string, size = 10, bold = false, gray = 0) {
    this.push(`BT /${bold ? "F2" : "F1"} ${size} Tf ${gray} g ${x.toFixed(2)} ${y.toFixed(2)} Td (`);
    this.chunks.push(escapeBytes(encode(value)));
    this.push(") Tj ET\n");
  }

  /** Cifras alineadas a la derecha en `xRight`. */
  number(xRight: number, y: number, value: string, size = 10, bold = false) {
    this.text(xRight - numericWidth(value, size), y, value, size, bold);
  }

  line(x1: number, y1: number, x2: number, y2: number, gray = 0.8) {
    this.push(`${gray} G 0.6 w ${x1} ${y1} m ${x2} ${y2} l S\n`);
  }

  rect(x: number, y: number, w: number, h: number, gray: number) {
    this.push(`${gray} g ${x} ${y} ${w} ${h} re f 0 g\n`);
  }

  bytes(): number[] {
    return this.chunks.flat();
  }
}

function ascii(text: string): number[] {
  return Array.from(text, (c) => c.charCodeAt(0));
}

/** Arma el archivo: objetos numerados, tabla de referencias cruzadas con los desplazamientos reales en bytes. */
function assemble(content: number[]): Uint8Array {
  const out: number[] = [...ascii("%PDF-1.4\n"), 0x25, 0xe2, 0xe3, 0xcf, 0xd3, 0x0a];
  const offsets: number[] = [];
  const add = (body: number[]) => {
    offsets.push(out.length);
    out.push(...ascii(`${offsets.length} 0 obj\n`), ...body, ...ascii("\nendobj\n"));
  };

  add(ascii("<< /Type /Catalog /Pages 2 0 R >>"));
  add(ascii("<< /Type /Pages /Kids [3 0 R] /Count 1 >>"));
  add(ascii(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${PAGE_W} ${PAGE_H}] /Resources << /Font << /F1 4 0 R /F2 5 0 R >> >> /Contents 6 0 R >>`));
  add(ascii("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>"));
  add(ascii("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>"));
  add([...ascii(`<< /Length ${content.length} >>\nstream\n`), ...content, ...ascii("\nendstream")]);

  const xref = out.length;
  out.push(...ascii(`xref\n0 ${offsets.length + 1}\n0000000000 65535 f \n`));
  for (const off of offsets) out.push(...ascii(`${String(off).padStart(10, "0")} 00000 n \n`));
  out.push(...ascii(`trailer\n<< /Size ${offsets.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`));
  return Uint8Array.from(out);
}

const cut = (text: string, max: number) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);

/**
 * El reporte de la semana. `data` debe traer `week` y `days` (la respuesta de
 * `/api/settlement?semana=`) y el resumen de toda la semana, no el de un día.
 */
export function buildWeeklyReportPdf(data: Settlement, agencyName: string, generatedAt: Date = new Date()): Uint8Array {
  if (!data.week || !data.days) throw new Error("El reporte semanal necesita la respuesta de la semana");
  const { start, end } = data.week;
  const year = parseYmd(end)?.y ?? "";
  const rate = `${Math.round(data.agencyRate * 100)} %`;
  const p = new Page();
  const right = PAGE_W - MARGIN;
  let y = PAGE_H - MARGIN;

  // Encabezado
  p.rect(0, PAGE_H - 96, PAGE_W, 96, 0.12);
  p.text(MARGIN, PAGE_H - 46, cut(agencyName, 40), 20, true, 1);
  p.text(MARGIN, PAGE_H - 68, "Reporte semanal de Finanzas", 11, false, 1);
  p.text(MARGIN, PAGE_H - 84, `${longDate(start)} – ${longDate(end)} ${year}`, 10, false, 0.85);
  y = PAGE_H - 96 - 34;

  // Resumen
  p.text(MARGIN, y, "Resumen de la semana", 13, true);
  y -= 8;
  p.line(MARGIN, y, right, y);
  y -= 22;
  const summary: [string, string][] = [
    ["Total generado", pdfMoney(data.total)],
    ["Domicilios entregados", String(data.deliveredCount)],
    ["Promedio por domicilio", pdfMoney(data.averageFee)],
    [`Parte de ${cut(agencyName, 28)} (${rate})`, pdfMoney(data.agencyShare)],
  ];
  for (const [label, value] of summary) {
    p.text(MARGIN, y, label, 11);
    p.number(right, y, value, 11, true);
    y -= 19;
  }

  // Por día
  y -= 14;
  p.text(MARGIN, y, "Desglose por día", 13, true);
  y -= 8;
  p.line(MARGIN, y, right, y);
  y -= 18;
  const colViajes = 330;
  const colGenerado = 440;
  p.text(MARGIN, y, "Día", 9, true, 0.35);
  p.number(colViajes, y, "Viajes", 9, true);
  p.number(colGenerado, y, "Generado", 9, true);
  p.number(right, y, "Para la agencia", 9, true);
  y -= 16;
  data.days.forEach((d, i) => {
    if (i % 2 === 1) p.rect(MARGIN - 4, y - 5, right - MARGIN + 8, 17, 0.96);
    p.text(MARGIN, y, `${DAY_NAMES_LONG[i]} ${shortDate(d.date)}`, 10);
    p.number(colViajes, y, String(d.deliveredCount), 10);
    p.number(colGenerado, y, pdfMoney(d.total), 10);
    p.number(right, y, pdfMoney(d.agencyShare), 10);
    y -= 17;
  });

  // Por motorizado
  y -= 14;
  p.text(MARGIN, y, "Desglose por motorizado", 13, true);
  y -= 8;
  p.line(MARGIN, y, right, y);
  y -= 18;
  p.text(MARGIN, y, "Motorizado", 9, true, 0.35);
  p.number(colViajes, y, "Viajes", 9, true);
  p.number(colGenerado, y, "Generado", 9, true);
  p.number(right, y, "Para la agencia", 9, true);
  y -= 16;
  if (data.couriers.length === 0) {
    p.text(MARGIN, y, "No hubo entregas cerradas esta semana.", 10, false, 0.4);
    y -= 17;
  }
  data.couriers.slice(0, MAX_COURIER_ROWS).forEach((c, i) => {
    if (i % 2 === 1) p.rect(MARGIN - 4, y - 5, right - MARGIN + 8, 17, 0.96);
    p.text(MARGIN, y, cut(c.courierName, 34), 10);
    p.number(colViajes, y, String(c.deliveredCount), 10);
    p.number(colGenerado, y, pdfMoney(c.earned), 10);
    p.number(right, y, pdfMoney(c.agencyShare), 10);
    y -= 17;
  });
  if (data.couriers.length > MAX_COURIER_ROWS) {
    p.text(MARGIN, y, `y ${data.couriers.length - MAX_COURIER_ROWS} motorizados más (ver el detalle en el portal)`, 9, false, 0.4);
  }

  // Pie
  const today = bogotaDate(generatedAt);
  p.text(MARGIN, MARGIN - 12, `Generado el ${shortDate(today)} ${parseYmd(today)?.y ?? ""} · Solo domicilios; el valor de los pedidos es del restaurante.`, 8, false, 0.5);

  return assemble(p.bytes());
}

/** Nombre del archivo: `finanzas-semana-2026-11-16.pdf` (el lunes de la semana). */
export function reportFileName(weekStartYmd: string): string {
  return `finanzas-semana-${weekStartYmd}.pdf`;
}

/** Lo descarga como archivo. Solo en el navegador. */
export function downloadPdf(bytes: Uint8Array, fileName: string): void {
  const blob = new Blob([bytes as BlobPart], { type: "application/pdf" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = fileName;
  link.rel = "noopener";
  document.body.appendChild(link);
  link.click();
  link.remove();
  // En algunos celulares la descarga empieza después del clic: no se suelta de inmediato.
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

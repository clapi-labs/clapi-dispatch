import {
  ambiguousAddress,
  haversineKm,
  insideRing,
  serviceVerdictAt,
  type LatLngPoint,
  type ServiceZoneShape,
} from "@dispatch/shared";

import { buildGeocodeQuery, interpretGeocode, requestedMunicipality, type GeocodeOutcome, type GoogleGeocodeResponse } from "./geocode";

/**
 * La medición de precisión de las direcciones (docs/DIRECCIONES-Y-ZONAS.md,
 * «Precisión de las direcciones»): cada caso de `apps/bot/direcciones/casos.json`
 * con su punto real, verificado en Google Maps, contra lo que ubica el bot.
 *
 * Aquí está todo lo que no necesita red: revisar los casos, juzgar cada
 * resultado y armar el informe. La consulta a Google la hace
 * `scripts/address-bench.ts`, desde el servidor (la llave solo sirve ahí).
 */

export type Municipality = "cali" | "jamundi" | "yumbo" | "candelaria" | "palmira";
const MUNICIPALITIES: Municipality[] = ["cali", "jamundi", "yumbo", "candelaria", "palmira"];

/** `ubicar`: tiene un punto y el bot debe darlo. `escalar`: no hay un punto
 *  (solo el barrio, sin placa…) y no debe inventarlo. `cualquiera`: puede
 *  ubicarla o pasarla a la central, pero nunca fuera de su municipio. */
export type Expected = "ubicar" | "escalar" | "cualquiera";

export type Reference = LatLngPoint & { lugar?: string; fuente: string; verificado: string };

export type AddressCase = {
  id: string;
  zona: string;
  tipo: string;
  /** Lo que escribe el restaurante. */
  texto: string;
  /** Lo que debe quedar en `direccionEntrega` al leer el mensaje; si falta, el texto. */
  direccion?: string;
  /** La puerta (torre, apto, casa, local), que va aparte. */
  detalle?: string;
  esperado: Expected;
  municipio: Municipality;
  /** El bot la confirma con el restaurante antes de cotizar (`ambiguousAddress`). */
  dudosa?: boolean;
  /** El punto real, verificado en Google Maps. Sin él, el caso no entra en el porcentaje. */
  referencia: Reference | null;
  nota?: string;
};

export const caseAddress = (c: AddressCase) => c.direccion ?? c.texto;

/** Hasta aquí, la puerta o la de al lado. */
export const EXACT_M = 50;
/** Hasta aquí, la misma cuadra o la siguiente: el precio no cambia. */
export const ACCEPTABLE_M = 150;
/** Más que esto es otro sector: precio, zona y moto salen mal. */
export const FAR_M = 500;

/** Revisa la forma del archivo de casos. Devuelve los errores. */
export function validateCases(file: unknown): string[] {
  const casos = (file as { casos?: unknown })?.casos;
  if (!Array.isArray(casos) || casos.length === 0) return ["falta la lista «casos»"];
  const errors: string[] = [];
  const seen = new Set<string>();
  for (const [i, raw] of casos.entries()) {
    const c = raw as Partial<AddressCase>;
    const at = `caso ${c.id ?? i}`;
    if (!c.id || typeof c.id !== "string") errors.push(`${at}: falta el id`);
    else if (seen.has(c.id)) errors.push(`${at}: id repetido`);
    else seen.add(c.id);
    if (!c.texto?.trim()) errors.push(`${at}: falta el texto`);
    if (!["ubicar", "escalar", "cualquiera"].includes(c.esperado as string)) errors.push(`${at}: «esperado» debe ser ubicar, escalar o cualquiera`);
    if (!MUNICIPALITIES.includes(c.municipio as Municipality)) errors.push(`${at}: municipio desconocido`);
    const r = c.referencia;
    if (r === undefined) errors.push(`${at}: falta «referencia» (null si no está verificada)`);
    if (r) {
      if (![r.lat, r.lng].every((n) => typeof n === "number" && Number.isFinite(n))) errors.push(`${at}: la referencia no tiene lat y lng`);
      else if (r.lat < 3.0 || r.lat > 3.8 || r.lng < -76.8 || r.lng > -76.2) errors.push(`${at}: la referencia queda fuera de Cali y sus alrededores`);
      if (!r.fuente?.trim() || !r.verificado?.trim()) errors.push(`${at}: la referencia no dice de dónde salió ni quién la verificó`);
      if (c.esperado === "escalar") errors.push(`${at}: un caso para escalar no tiene punto de referencia`);
    }
  }
  return errors;
}

/**
 * Lo que se puede revisar sin Google: que el bot busque en el municipio que
 * es (el error de 6256a75 era pegarle «Cali» a una dirección de Jamundí),
 * que confirme las direcciones sin tipo de vía y que la puerta no quede en
 * la dirección que va al mapa.
 */
export function offlineProblems(c: AddressCase): string[] {
  const address = caseAddress(c);
  const problems: string[] = [];
  const asked = requestedMunicipality(address)?.key ?? "cali";
  if (asked !== c.municipio) problems.push(`busca en «${asked}» y la dirección es de «${c.municipio}»`);
  const query = buildGeocodeQuery(address);
  if (c.municipio !== "cali" && /,\s*cali,/iu.test(query)) problems.push(`le pega Cali a una dirección de ${c.municipio}: «${query}»`);
  if (ambiguousAddress(address) !== !!c.dudosa) problems.push(c.dudosa ? "no la marca como dudosa" : "la marca como dudosa sin serlo");
  if (c.detalle) {
    const squash = (t: string) => t.toLowerCase().replace(/[^a-z0-9]/g, "");
    if (squash(address).includes(squash(c.detalle))) problems.push("la puerta quedó en la dirección que va al mapa");
    if (!squash(c.texto).includes(squash(c.detalle))) problems.push("la puerta no está en el texto");
  }
  return problems;
}

/** Un barrio de Cali (apps/portal/public/zonas/barrios.json), con su borde. */
export type Barrio = { nombre: string; ring: LatLngPoint[] };

/** Los barrios del archivo del mapa de zonas: `borde` viene como [lat, lng]. */
export function barriosFromFile(file: unknown): Barrio[] {
  const list = (file as { barrios?: { nombre: string; borde: [number, number][] }[] })?.barrios ?? [];
  return list.map((b) => ({ nombre: b.nombre, ring: b.borde.map(([lat, lng]) => ({ lat, lng })) }));
}

/** El barrio de Cali donde cae el punto, o null si queda fuera del perímetro
 *  urbano y del suelo de expansión (otro municipio, o zona rural). Es la
 *  prueba de municipio que no depende de Google: los bordes son de la IDESC. */
export function caliBarrioAt(point: LatLngPoint, barrios: Barrio[]): string | null {
  return barrios.find((b) => insideRing(point, b.ring))?.nombre ?? null;
}

/** Lo que devolvió Google para el caso, para mostrarlo en el informe. */
export type GoogleSeen = { status: string; formatted: string | null; locationType: string | null; partial: boolean; results: number };

export type Located = {
  outcome: GeocodeOutcome;
  google?: GoogleSeen | null;
  /** Con `--extraccion`: la dirección que leyó el modelo en el texto. */
  extracted?: string | null;
};

/** Lo que decide el bot con una respuesta de Google (`interpretGeocode`, lo
 *  mismo que al cotizar), y lo que Google dijo de su primer resultado. */
export function locatedFromGoogle(data: GoogleGeocodeResponse, address: string, extracted: string | null = null): Located {
  const first = data.results?.[0];
  return {
    outcome: interpretGeocode(data, address),
    google: {
      status: data.status,
      formatted: first?.formatted_address ?? null,
      locationType: first?.geometry.location_type ?? null,
      partial: !!first?.partial_match,
      results: data.results?.length ?? 0,
    },
    extracted,
  };
}

export type Verdict =
  /** A 50 m o menos. */
  | "exacto"
  /** A 150 m o menos. */
  | "aceptable"
  /** A más de 150 m. */
  | "fallo"
  /** A más de 500 m: otro sector. */
  | "lejos"
  /** Cayó en otro municipio. */
  | "otro_municipio"
  /** No había un punto y el bot dio uno. */
  | "falso_positivo"
  /** Había un punto y el bot no lo dio: pasa a la central. Cuesta tiempo, no plata. */
  | "escalo"
  /** No había un punto (o no se pedía) y pasó a la central. */
  | "escalo_bien"
  /** La ubicó, pero falta el punto verificado para medirla. */
  | "sin_referencia"
  /** Google no respondió o la llave no sirve: no se pudo medir. */
  | "error";

/** Lo que nunca debe pasar: cobra mal o manda la moto a otro lado. */
export const SERIOUS: Verdict[] = ["lejos", "otro_municipio", "falso_positivo"];

type CoverageKind = "dentro" | "cerca" | "fuera" | "sin_zonas";

export type CaseResult = {
  id: string;
  tipo: string;
  zona: string;
  texto: string;
  direccion: string;
  esperado: Expected;
  /** Tiene punto verificado en Google Maps. */
  verified: boolean;
  verdict: Verdict;
  /** Del punto del bot al verificado. */
  meters: number | null;
  point: LatLngPoint | null;
  /** El barrio de Cali donde cayó el punto del bot. */
  barrio: string | null;
  /** Dónde cae en las zonas de servicio el punto del bot y el verificado. */
  coverage: { sistema: CoverageKind; referencia: CoverageKind | null } | null;
  /** Si el bot decide distinto de lo que decidiría con el punto real. */
  coverageProblem: string | null;
  google: GoogleSeen | null;
  extracted: string | null;
};

const coverageKind = (point: LatLngPoint, zones: ServiceZoneShape[]): CoverageKind => serviceVerdictAt(point, zones).kind;

const COVERAGE_TEXT: Record<CoverageKind, string> = {
  dentro: "dentro",
  cerca: "cerca del borde (decide la central)",
  fuera: "fuera (no hay servicio)",
  sin_zonas: "sin zonas",
};

/** Juzga un caso con lo que ubicó el bot. `zones` null: no se revisa la cobertura. */
export function judgeCase(c: AddressCase, located: Located, ctx: { barrios: Barrio[]; zones: ServiceZoneShape[] | null }): CaseResult {
  const base = {
    id: c.id,
    tipo: c.tipo,
    zona: c.zona,
    texto: c.texto,
    direccion: located.extracted ?? caseAddress(c),
    esperado: c.esperado,
    verified: !!c.referencia,
    google: located.google ?? null,
    extracted: located.extracted ?? null,
  };
  const { outcome } = located;
  if (outcome.kind === "failed" || outcome.kind === "disabled") {
    return { ...base, verdict: "error", meters: null, point: null, barrio: null, coverage: null, coverageProblem: null };
  }
  if (outcome.kind === "not_found") {
    const verdict = c.esperado === "ubicar" ? "escalo" : "escalo_bien";
    return { ...base, verdict, meters: null, point: null, barrio: null, coverage: null, coverageProblem: null };
  }

  const point = outcome.location;
  const barrio = caliBarrioAt(point, ctx.barrios);
  const ref = c.referencia;
  const meters = ref ? Math.round(haversineKm(point, ref) * 1000) : null;

  let verdict: Verdict;
  if (c.municipio !== "cali" && barrio) verdict = "otro_municipio";
  else if (c.esperado === "escalar") verdict = "falso_positivo";
  else if (meters === null) verdict = "sin_referencia";
  else if (meters <= EXACT_M) verdict = "exacto";
  else if (meters <= ACCEPTABLE_M) verdict = "aceptable";
  else if (meters <= FAR_M) verdict = "fallo";
  else verdict = "lejos";

  let coverage: CaseResult["coverage"] = null;
  let coverageProblem: string | null = null;
  if (ctx.zones) {
    coverage = { sistema: coverageKind(point, ctx.zones), referencia: ref ? coverageKind(ref, ctx.zones) : null };
    if (coverage.referencia && coverage.referencia !== coverage.sistema) {
      coverageProblem = `con el punto real sería «${COVERAGE_TEXT[coverage.referencia]}» y el bot lo ve «${COVERAGE_TEXT[coverage.sistema]}»`;
    }
  }
  return { ...base, verdict, meters, point, barrio, coverage, coverageProblem };
}

function percentile(sorted: number[], p: number): number | null {
  if (!sorted.length) return null;
  return sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)];
}

export type Summary = {
  total: number;
  counts: Record<Verdict, number>;
  /** Los que deben ubicarse y tienen punto verificado: la base del porcentaje. */
  measurable: number;
  /** Exactos y aceptables entre los medibles. */
  hits: number;
  hitRate: number | null;
  /** Error en metros de los que ubicó con punto verificado. */
  medianM: number | null;
  p90M: number | null;
  maxM: number | null;
  serious: CaseResult[];
  coverageProblems: CaseResult[];
};

export function summarize(results: CaseResult[]): Summary {
  const counts = Object.fromEntries(
    (["exacto", "aceptable", "fallo", "lejos", "otro_municipio", "falso_positivo", "escalo", "escalo_bien", "sin_referencia", "error"] as Verdict[]).map((v) => [v, 0]),
  ) as Record<Verdict, number>;
  for (const r of results) counts[r.verdict]++;
  // Los que debía ubicar y tienen punto verificado. Si no la ubicó, cuenta
  // como no acertada; si Google no respondió, no se midió.
  const measurable = results.filter((r) => r.esperado === "ubicar" && r.verified && r.verdict !== "error");
  const hits = measurable.filter((r) => r.verdict === "exacto" || r.verdict === "aceptable").length;
  const errors = results.flatMap((r) => (r.meters === null ? [] : [r.meters])).sort((a, b) => a - b);
  return {
    total: results.length,
    counts,
    measurable: measurable.length,
    hits,
    hitRate: measurable.length ? hits / measurable.length : null,
    medianM: percentile(errors, 50),
    p90M: percentile(errors, 90),
    maxM: errors.length ? errors[errors.length - 1] : null,
    serious: results.filter((r) => SERIOUS.includes(r.verdict)),
    coverageProblems: results.filter((r) => r.coverageProblem),
  };
}

const VERDICT_LABEL: Record<Verdict, string> = {
  exacto: "Exacto (≤ 50 m)",
  aceptable: "Aceptable (≤ 150 m)",
  fallo: "Fallo (> 150 m)",
  lejos: "Lejos (> 500 m)",
  otro_municipio: "Otro municipio",
  falso_positivo: "Falso positivo (inventó un punto)",
  escalo: "Pasó a la central teniendo punto",
  escalo_bien: "Pasó a la central (bien)",
  sin_referencia: "Ubicada, falta verificar el punto",
  error: "Error (Google no respondió)",
};

const pct = (n: number) => `${Math.round(n * 1000) / 10} %`;
const m = (n: number | null) => (n === null ? "—" : `${n} m`);
const cell = (t: string | null | undefined) => (t ?? "—").replace(/\|/g, "/");

/** El informe en Markdown: el resumen, lo grave y la tabla de cada caso. */
export function renderReport(results: CaseResult[], meta: { fecha: string; servidor: string; extraccion: boolean; zonas: number | null }): string {
  const s = summarize(results);
  const lines: string[] = [];
  lines.push(`# Precisión de las direcciones — ${meta.fecha}`);
  lines.push("");
  lines.push(`- Servidor: ${meta.servidor}. Lectura del texto con el modelo: ${meta.extraccion ? "sí" : "no (la dirección esperada va directo al mapa)"}.`);
  lines.push(`- Zonas de servicio: ${meta.zonas === null ? "no se revisaron (sin base)" : `${meta.zonas}`}.`);
  lines.push(`- Casos: ${s.total}. Con punto verificado que el bot debía ubicar: ${s.measurable}.`);
  lines.push(`- **Acierto: ${s.hitRate === null ? "—" : `${pct(s.hitRate)} (${s.hits} de ${s.measurable})`}** a 150 m o menos del punto real.`);
  lines.push(`- Error de lo que ubicó: mediana ${m(s.medianM)}, 90 % ${m(s.p90M)}, máximo ${m(s.maxM)}.`);
  lines.push(`- Graves (otro sector, otro municipio o punto inventado): **${s.serious.length}**. Cobertura distinta de la real: **${s.coverageProblems.length}**.`);
  lines.push("");
  lines.push("| Resultado | Casos |");
  lines.push("|---|---|");
  for (const [v, n] of Object.entries(s.counts)) if (n) lines.push(`| ${VERDICT_LABEL[v as Verdict]} | ${n} |`);
  lines.push("");
  if (s.serious.length || s.coverageProblems.length) {
    lines.push("## Para revisar");
    lines.push("");
    for (const r of [...s.serious, ...s.coverageProblems.filter((r) => !s.serious.includes(r))]) {
      const why = [VERDICT_LABEL[r.verdict], r.meters !== null ? `a ${r.meters} m` : null, r.coverageProblem, r.google?.formatted ? `Google: «${r.google.formatted}» (${r.google.locationType})` : null]
        .filter(Boolean)
        .join(" · ");
      lines.push(`- **${r.id}** «${r.texto}»: ${why}`);
    }
    lines.push("");
  }
  lines.push("## Cada caso");
  lines.push("");
  lines.push(`| Caso | Texto | ${meta.extraccion ? "Leída | " : ""}Resultado | Error | Barrio (IDESC) | Cobertura | Google |`);
  lines.push(`|---|---|${meta.extraccion ? "---|" : ""}---|---|---|---|---|`);
  for (const r of results) {
    const google = r.google ? `${r.google.status}${r.google.locationType ? ` ${r.google.locationType}` : ""}${r.google.partial ? " parcial" : ""}` : "—";
    const coverage = r.coverage ? (r.coverage.referencia && r.coverage.referencia !== r.coverage.sistema ? `${r.coverage.sistema} (real: ${r.coverage.referencia})` : r.coverage.sistema) : "—";
    lines.push(
      `| ${r.id} | ${cell(r.texto)} | ${meta.extraccion ? `${cell(r.extracted)} | ` : ""}${VERDICT_LABEL[r.verdict]} | ${m(r.meters)} | ${cell(r.barrio)} | ${coverage} | ${google} |`,
    );
  }
  lines.push("");
  return lines.join("\n");
}

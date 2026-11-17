/**
 * Mide qué tan bien ubica el bot las direcciones, contra Google de verdad
 * (docs/DIRECCIONES-Y-ZONAS.md, «Precisión de las direcciones»). La llave de
 * Google solo funciona desde la IP del servidor: se corre allá, con
 * `deploy/measure-addresses.sh`. No va en CI ni en `npm test`.
 *
 *   npm run bot:direcciones:medir                      # todos los casos
 *   npm run bot:direcciones:medir -- --solo trampa-01,estandar-02
 *   npm run bot:direcciones:medir -- --extraccion      # además lee el texto con el modelo (gasta OpenAI)
 *   npm run bot:direcciones:medir -- --salida <carpeta> # deja informe.md y resultados.json
 *
 * Una consulta a Google por caso (unos 100: dentro de las 10.000 gratis del mes).
 * Con DATABASE_URL revisa también las zonas de servicio de esa base. No
 * escribe en la base. Termina con error si hay algún caso grave.
 *
 * Para cargar el punto verificado de un caso (copiado de Google Maps, con clic
 * derecho sobre el pin, o el enlace largo):
 *
 *   npm run bot:direcciones:referencia -- lugar-01 "3.4759489, -76.5276424"
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { emptyDraft, parseCoordinates, type ServiceZoneShape } from "@dispatch/shared";

import {
  barriosFromFile,
  caseAddress,
  judgeCase,
  locatedFromGoogle,
  renderReport,
  summarize,
  validateCases,
  type AddressCase,
  type CaseResult,
  type Located,
} from "../src/services/google/address-bench";
import { requestGeocode } from "../src/services/google/geocode";

const CASES_PATH = fileURLToPath(new URL("../direcciones/casos.json", import.meta.url));
const BARRIOS_PATH = fileURLToPath(new URL("../../portal/public/zonas/barrios.json", import.meta.url));

function arg(name: string): string | null {
  const i = process.argv.indexOf(name);
  return i >= 0 ? (process.argv[i + 1] ?? null) : null;
}

/** Corta con un mensaje para quien lo corre. Sale con 2, no con `process.exit`
 *  en el acto: en Windows, salir con un `fetch` recién cerrado tumba a Node. */
class Stop extends Error {}
function fail(message: string): never {
  throw new Stop(message);
}

function loadCases() {
  const file = JSON.parse(readFileSync(CASES_PATH, "utf8"));
  const errors = validateCases(file);
  if (errors.length) fail(`casos.json tiene errores:\n${errors.join("\n")}`);
  return file as { casos: AddressCase[] };
}

/** Carga el punto verificado de un caso, sin red. */
function setReference(id: string, pasted: string) {
  const file = JSON.parse(readFileSync(CASES_PATH, "utf8")) as { casos: AddressCase[] };
  const c = file.casos.find((x) => x.id === id);
  if (!c) fail(`No hay un caso «${id}».`);
  const point = parseCoordinates(pasted);
  if (!point) fail("No reconozco las coordenadas: pega «3.37261, -76.53012» (clic derecho sobre el pin) o el enlace largo de Google Maps.");
  if (c.esperado === "escalar") fail(`«${id}» es un caso para escalar: no lleva punto.`);
  const today = new Date().toLocaleDateString("en-CA", { timeZone: "America/Bogota" });
  c.referencia = {
    lat: Math.round(point.lat * 1e6) / 1e6,
    lng: Math.round(point.lng * 1e6) / 1e6,
    fuente: "Pin de Google Maps, comprobado en el mapa",
    verificado: today,
  };
  const errors = validateCases(file);
  if (errors.length) fail(errors.join("\n"));
  writeFileSync(CASES_PATH, `${JSON.stringify(file, null, 2)}\n`);
  console.log(`${id}: ${c.referencia.lat}, ${c.referencia.lng} (${today}).`);
}

async function zonesOrNull(): Promise<ServiceZoneShape[] | null> {
  if (!process.env.DATABASE_URL) return null;
  const { listServiceZones } = await import("@dispatch/shared/db");
  return listServiceZones();
}

/** Con `--extraccion`, la dirección que lee el modelo en el texto, como en una conversación nueva. */
async function extractAddress(text: string): Promise<string | null> {
  const { interpretMessage } = await import("../src/services/openai/extract");
  const outcome = await interpretMessage(text, emptyDraft());
  return outcome.fields.entregas[0]?.direccionEntrega ?? null;
}

async function locate(c: AddressCase, withExtraction: boolean): Promise<Located> {
  const extracted = withExtraction ? await extractAddress(c.texto) : null;
  if (withExtraction && !extracted) return { outcome: { kind: "not_found" }, google: null, extracted: null };
  const address = extracted ?? caseAddress(c);
  const response = await requestGeocode(address);
  if (response.kind !== "response") return { outcome: response, google: null, extracted };
  if (response.data.status === "REQUEST_DENIED") {
    fail(`Google respondió REQUEST_DENIED (${response.data.error_message ?? ""}). La llave solo sirve desde el servidor: correr con deploy/measure-addresses.sh.`);
  }
  return locatedFromGoogle(response.data, address, extracted);
}

async function measure(): Promise<number> {
  if (process.env.GEOCODE_SIMULADO === "true") fail("GEOCODE_SIMULADO=true: la ubicación sería de mentira. Quitarlo para medir.");
  if (!process.env.GOOGLE_MAPS_API_KEY) fail("Falta GOOGLE_MAPS_API_KEY. Se mide desde el servidor: deploy/measure-addresses.sh.");

  const withExtraction = process.argv.includes("--extraccion");
  const only = arg("--solo")?.split(",").map((s) => s.trim());
  const out = arg("--salida");
  const { casos } = loadCases();
  const cases = only ? casos.filter((c) => only.includes(c.id)) : casos;
  if (!cases.length) fail("Ningún caso coincide con --solo.");

  const barrios = barriosFromFile(JSON.parse(readFileSync(BARRIOS_PATH, "utf8")));
  const zones = await zonesOrNull();

  const results: CaseResult[] = [];
  for (const c of cases) {
    const result = judgeCase(c, await locate(c, withExtraction), { barrios, zones });
    results.push(result);
    console.error(`${result.id.padEnd(18)} ${result.verdict.padEnd(15)} ${result.meters === null ? "" : `${result.meters} m`}`);
  }

  const fecha = new Date().toLocaleString("sv-SE", { timeZone: "America/Bogota" }).slice(0, 16);
  const report = renderReport(results, { fecha, servidor: process.env.MEDICION_SERVIDOR ?? "local", extraccion: withExtraction, zonas: zones?.length ?? null });
  if (out) {
    mkdirSync(out, { recursive: true });
    writeFileSync(join(out, "informe.md"), report);
    // Con el punto que dio el bot: para verificar en Google Maps los que no tienen referencia.
    writeFileSync(join(out, "resultados.json"), `${JSON.stringify(results, null, 2)}\n`);
    console.error(`\nInforme en ${join(out, "informe.md")}`);
  }
  console.log(report);
  return summarize(results).serious.length ? 1 : 0;
}

async function main(): Promise<number> {
  if (process.argv[2] !== "--referencia") return measure();
  const [id, pasted] = [process.argv[3], process.argv.slice(4).join(" ")];
  if (!id || !pasted) fail('Uso: npm run bot:direcciones:referencia -- <caso> "<lat, lng o enlace de Google Maps>"');
  setReference(id, pasted);
  return 0;
}

main()
  .then((code) => {
    process.exitCode = code;
    // La conexión a la base no se cierra sola.
    if (process.env.DATABASE_URL) process.exit(code);
  })
  .catch((error) => {
    console.error(error instanceof Stop ? error.message : error instanceof Error ? (error.stack ?? error.message) : String(error));
    process.exitCode = 2;
    if (process.env.DATABASE_URL) process.exit(2);
  });

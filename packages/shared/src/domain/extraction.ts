/**
 * Interpretación del mensaje libre del restaurante y la memoria del pedido.
 *
 * El modelo SOLO interpreta; no decide, no calcula, no asigna. Mismo reparto
 * de responsabilidades que ya usaba CLAPI entre el modelo y el código
 * (ver ADR-08/ADR-09 del sistema original): el modelo dice qué escribió el
 * restaurante, el código valida, cotiza y decide qué sigue.
 *
 * Un pedido puede traer varias entregas (caso 4 de
 * docs/CONVERSACIONES-REALES.md: «5 cada uno»): comparten restaurante,
 * cotización y confirmación, y cada una termina en su propio viaje.
 */

import { normalizeName } from "./restaurant-identity";

/** `datafono`: el cliente paga con tarjeta al recibir, y el domiciliario
 *  lleva el datáfono del restaurante. */
export type PaymentMethod = "efectivo" | "transferencia" | "datafono";

/** Lo que el modelo lee de cada entrega. Las claves en español son las que
 *  devuelve el modelo y las que muestra el portal. */
type DeliveryFields = {
  direccionEntrega: string | null;
  telefonoCliente: string | null;
  nombreCliente: string | null;
  valorACobrar: number | null;
  metodoPago: PaymentMethod | null;
  /** Minutos que faltan para que la comida esté lista, contados desde el
   *  mensaje que lo dijo; 0 = ya está lista. */
  listoEnMinutos: number | null;
  /** Lo que no es un campo pero el motorizado necesita saber: "billete de
   *  100 mil", "2 hamburguesas". */
  notas: string | null;
  /** Torre y apartamento, casa, oficina o local: lo que va dentro de la
   *  dirección. Aparte de `direccionEntrega` para no volver a geocodificar
   *  (ni cotizar) cuando llega después. */
  detalleDireccion: string | null;
  /** La dirección es un conjunto, unidad, edificio o condominio: sin
   *  `detalleDireccion` el motorizado no sabe a qué puerta ir. */
  esConjunto: boolean | null;
  /** El barrio de la dirección: para nombrar la entrega en los mensajes
   *  («Serían $6.000 hasta Valle del Lili»). No se usa para cobrar. */
  barrio?: string | null;
  /** Los campos que el modelo leyó pero no está seguro (letra borrosa, un
   *  número incompleto, dos lecturas posibles). Se le muestran al restaurante
   *  marcados para que los confirme o los corrija. */
  dudas?: DoubtfulField[] | null;
  /** Un ticket que trae dos direcciones para el mismo cliente (el error de
   *  la caja que imprime dos): la otra, completa. El bot pregunta a cuál va
   *  antes de ubicar nada. */
  direccionAlterna?: string | null;
};

/** Lo que el modelo puede marcar como dudoso. */
export const DOUBTFUL_FIELDS = [
  "direccionEntrega",
  "detalleDireccion",
  "telefonoCliente",
  "nombreCliente",
  "valorACobrar",
  "metodoPago",
  "listoEnMinutos",
  "notas",
] as const;
export type DoubtfulField = (typeof DOUBTFUL_FIELDS)[number];

/** Una entrega del pedido: lo que dijo el restaurante y lo que calculó el código. */
export type DeliveryDraft = DeliveryFields & {
  /** Cuándo se envió el mensaje que dio `listoEnMinutos` (ISO). */
  listoDesde?: string | null;
  /** Coordenadas de la entrega: geocodificadas una vez o del pin de WhatsApp. */
  ubicacionEntrega?: { lat: number; lng: number } | null;
  /** La dirección que se geocodificó; si cambia, se vuelve a ubicar y cotizar. */
  direccionUbicada?: string | null;
  /** `km` null = el precio lo dio el asesor, sin distancia medida. `fuente`:
   *  de dónde salieron los km (`calle` = OSRM; `linea_recta` = línea recta ×
   *  1,3). Vacía en los borradores de antes de este dato. `desglose`: de dónde
   *  sale el precio (tabla por km y ajuste de la zona); vacío si lo puso la
   *  central. */
  cotizacion?: { precio: number; km: number | null; fuente?: "google" | "calle" | "linea_recta"; desglose?: FareSplit | null } | null;
  /** El mapa no la ubicó, pero el asesor dijo que es válida y cuánto vale:
   *  no se vuelve a buscar mientras no cambie la dirección. */
  validadaPorAsesor?: boolean;
};

/** De dónde sale un precio: lo de la tabla por km, el ajuste de la zona de la
 *  entrega y el nombre de esa zona (null sin zona). */
export type FareSplit = { tabla: number; ajuste: number; zona: string | null };

/** Una entrega cerca del borde de una zona de servicio, para que la central
 *  decida si se hace: la zona más cercana, a cuántos metros y lo que vale
 *  (lo que se cobra si dice que sí y no lo cambia). */
export type CoverageQueryItem = {
  indice: number;
  zona: string;
  metros: number;
  precio: number;
  km: number;
  fuente?: "google" | "calle" | "linea_recta";
  desglose?: FareSplit | null;
};

/** Lo que el bot le preguntó a la central. `motivo` vacío o "direccion": el
 *  mapa no ubicó la dirección (¿es válida y cuánto vale?). "cobertura": la
 *  entrega quedó fuera de las zonas de servicio, cerca del borde (¿se hace?).
 *  `entregas`: las que pregunta, por posición. Mientras espera, el bot no
 *  responde en ese chat. */
export type AdvisorQuery = { entregas: number[]; desde: string; motivo?: "direccion" | "cobertura"; cobertura?: CoverageQueryItem[] };

/** En qué va el pedido: `cotizado` = ya se le mandó el precio y se espera la
 *  confirmación; `confirmado` = confirmó y se espera lo que falte. */
export type OrderStage = "recibiendo" | "cotizado" | "confirmado";

/** Lo que un mensaje puede cambiar de un pedido ya creado. */
export type TripUpdate = Partial<
  Pick<DeliveryFields, "listoEnMinutos" | "notas" | "telefonoCliente" | "nombreCliente" | "valorACobrar" | "metodoPago" | "detalleDireccion">
> & {
  /** Cuándo se dijo el tiempo (ISO), para contar desde ahí. */
  desde: string;
};

/** El pedido a medio armar de una conversación (`conversations.draft`). */
export type OrderDraft = {
  etapa: OrderStage;
  /** Dónde se recoge. Solo se pide a un restaurante sin registrar: al
   *  registrado se le conoce por su número. */
  origenRestaurante: string | null;
  /** Coordenadas de la recogida de un restaurante sin registrar, ubicadas una
   *  vez desde `origenRestaurante`. Al registrado se le conoce por su número. */
  ubicacionRecogida?: { lat: number; lng: number } | null;
  recogidaUbicada?: string | null;
  entregas: DeliveryDraft[];
  /** El mensaje del restaurante que abrió el pedido: los avisos le responden
   *  citándolo, para que sepa de qué pedido se habla. */
  mensajeOrigen?: string | null;
  /** Un cambio para un pedido ya creado (por ejemplo «ya está listo») cuando
   *  hay varios abiertos y se preguntó a cuál se refiere. */
  actualizacionPendiente?: TripUpdate | null;
  /** El pedido completo que se le mostró con el botón de confirmar
   *  (`summaryOf` en el bot). Confirmar pide la moto solo si sigue igual: si
   *  algo cambió, se le vuelve a mostrar. */
  resumenMostrado?: string | null;
  /** El restaurante solo preguntó el precio («¿cuánto a Pance?»): se le
   *  respondió sin pedirle que confirme. Pasa a pedido cuando decide
   *  mandarlo («dale», los datos del cliente, el tiempo). */
  soloPrecio?: boolean;
  /** Algo que decide la central y responde en el portal: el mapa no ubicó una
   *  dirección (¿es válida y cuánto vale?), o la entrega quedó cerca del borde
   *  de una zona de servicio (¿se hace?). Ver `AdvisorQuery`. */
  consultaAsesor?: AdvisorQuery | null;
  /** Los nombres ya comparados con los restaurantes (normalizados): cada uno
   *  se compara una sola vez por pedido. */
  nombresRevisados?: string[];
  /** Un número registrado dijo ser otro restaurante y se le preguntó si es
   *  el suyo. Se pregunta una sola vez. */
  preguntaIdentidad?: boolean;
  /** Ya se le recordó que debe confirmarlo antes de la hora límite: sale una
   *  sola vez por pedido. */
  recordatorioCierre?: boolean;
  /** Última vez que este borrador recibió datos del restaurante o de la central. */
  actualizadoEn?: string | null;
};

/** Tiempo máximo que un borrador abandonado sin asesor sigue activo antes de
 *  empezar de cero cuando el restaurante vuelva a escribir. */
export const DRAFT_TTL_MS = 60 * 60_000;

/** Un borrador viejo y sin consulta abierta no debe secuestrar un mensaje nuevo horas después. */
export function isStaleDraft(draft: OrderDraft, now: Date): boolean {
  if (!draft.entregas.length && !draft.origenRestaurante && !draft.soloPrecio) return false;
  if (draft.consultaAsesor || draft.preguntaIdentidad) return false;
  const stamps = [draft.actualizadoEn, ...draft.entregas.map((d) => d.listoDesde)]
    .map((s) => (s ? Date.parse(s) : NaN))
    .filter(Number.isFinite);
  if (!stamps.length) return false;
  return now.getTime() - Math.max(...stamps) > DRAFT_TTL_MS;
}

const GREETING_ONLY_RE = /^\s*(?:hola|buen(?:os|as)(?:\s+(?:d[ií]as|tardes|noches))?|saludos)\b[\s.!?,]*$/iu;

/**
 * Calla solo cuando YA se le mostró este precio antes (`hadPriceBefore`) y el
 * restaurante respondió algo neutro («ok», «gracias») sin pedir nada nuevo,
 * preguntar ni saludar otra vez.
 */
export function shouldStaySilentAfterQuote(params: {
  hadPriceBefore: boolean;
  priceChanged: boolean;
  progressed: boolean;
  query: string | null;
  intent: "cotizar" | "pedir" | null;
  text: string;
}): boolean {
  return (
    !params.priceChanged &&
    params.hadPriceBefore &&
    !params.progressed &&
    !params.query &&
    params.intent === null &&
    !GREETING_ONLY_RE.test(params.text)
  );
}

/** Lo que devuelve el modelo por mensaje. */
export type Interpretation = {
  origenRestaurante: string | null;
  /** El nombre con que el restaurante se identifica en este mensaje. */
  nombreRestaurante?: string | null;
  entregas: DeliveryFields[];
  /** Posiciones (desde 1) de las entregas ya capturadas que pidió quitar. */
  quitar?: number[];
};

/** Lo que se puede exigir por agencia antes de crear el viaje. */
export type OrderFieldKey = "origenRestaurante" | Exclude<keyof DeliveryFields, "barrio" | "esConjunto" | "dudas" | "direccionAlterna">;

/** Los obligatorios del primer cliente. Cada agencia puede cambiarlos en
 *  `settings.bot_config` sin tocar el flujo. */
export const DEFAULT_REQUIRED_FIELDS: OrderFieldKey[] = ["direccionEntrega", "nombreCliente", "telefonoCliente", "listoEnMinutos"];

const DELIVERY_KEYS = [
  "direccionEntrega",
  "telefonoCliente",
  "nombreCliente",
  "valorACobrar",
  "metodoPago",
  "listoEnMinutos",
  "notas",
  "detalleDireccion",
  "esConjunto",
] as const;

export function emptyDelivery(): DeliveryDraft {
  return {
    direccionEntrega: null,
    telefonoCliente: null,
    nombreCliente: null,
    valorACobrar: null,
    metodoPago: null,
    listoEnMinutos: null,
    notas: null,
    detalleDireccion: null,
    esConjunto: null,
    barrio: null,
    dudas: null,
  };
}

export function emptyDraft(): OrderDraft {
  return { etapa: "recibiendo", origenRestaurante: null, entregas: [] };
}

/**
 * El borrador guardado en la forma de hoy. Uno de antes de que existieran
 * las entregas (una sola, con los campos sueltos) se convierte; así un
 * pedido a medio armar no se pierde al desplegar.
 */
export function normalizeDraft(raw: unknown): OrderDraft {
  if (!raw || typeof raw !== "object") return emptyDraft();
  const r = raw as Record<string, unknown>;
  if (Array.isArray(r.entregas)) return { ...emptyDraft(), ...(r as Partial<OrderDraft>), entregas: r.entregas as DeliveryDraft[] };
  const legacy = { ...emptyDelivery(), ...(r as Partial<DeliveryDraft>) };
  const hasDelivery = DELIVERY_KEYS.some((k) => legacy[k] != null);
  return {
    etapa: (r.etapa as OrderStage) ?? "recibiendo",
    origenRestaurante: (r.origenRestaurante as string) ?? null,
    mensajeOrigen: (r.mensajeOrigen as string) ?? null,
    actualizacionPendiente: (r.actualizacionPendiente as TripUpdate) ?? null,
    entregas: hasDelivery ? [legacy] : [],
  };
}

/** Lo que le falta a una entrega para crear su viaje. `origenRestaurante`
 *  es del pedido, no de la entrega: se revisa aparte. */
export function missingFields(delivery: DeliveryDraft, required: OrderFieldKey[]): Exclude<OrderFieldKey, "origenRestaurante">[] {
  const missing = required.filter((k): k is Exclude<OrderFieldKey, "origenRestaurante"> => k !== "origenRestaurante" && delivery[k] == null);
  // En un conjunto o edificio la torre y el apartamento son obligatorios para
  // toda agencia: sin ellos el motorizado llega a la portería y no sabe a quién.
  // Además de lo que diga el modelo, se revisa la dirección: si nombra un
  // conjunto, edificio o torre y no trae el detalle, se pide igual.
  const multiUnit = delivery.esConjunto || looksLikeMultiUnit(delivery.direccionEntrega);
  if (multiUnit && !delivery.detalleDireccion && !missing.includes("detalleDireccion")) missing.push("detalleDireccion");
  return missing;
}

/** Palabras que dicen que en esa dirección vive más de una familia, así que
 *  hace falta la torre, el apartamento o la casa para llegar a la puerta. */
const MULTI_UNIT_WORDS =
  /\b(conjunto|conj|unidad(?!\s+(deportiva|m[eé]dica|de\s+(cuidados?|urgencias?|salud|servicios?|rehabilitaci[oó]n|di[aá]lisis|oncolog[ií]a|maternidad|quemados|trasplantes?|hospitalizaci[oó]n)\b))|edificio|edif|edf|torres?|bloques?|apto|apartamentos?|condominio|multifamiliar(es)?|residencias)\b/iu;

/** «apto 302», «torre 2», «casa 14», «bloque C»: la puerta ya viene en el texto. */
const UNIT_NUMBER = /\b(apto|apartamento|torre|bloque|casa|interior|int)\b\.?\s*(n[°º.o]?\s*)?#?\s*([a-z]?\d+|[a-z]\b)/iu;

/** La dirección nombra un conjunto, edificio o torre pero no dice a qué
 *  puerta ir. */
export function looksLikeMultiUnit(address: string | null | undefined): boolean {
  return !!address && MULTI_UNIT_WORDS.test(address) && !UNIT_NUMBER.test(address);
}

/** Calle, carrera, avenida…: el tipo de vía, sin el cual «la 42 con 83» puede
 *  ser una calle o una carrera. Vale pegado al número («cra97#45-11») y con
 *  los errores de tipeo de siempre («carerra», «cale»). */
const ROAD_TYPE =
  /(?<![\p{L}\p{N}])(cal+e|cll?|car+e+r+a|cra|cr|kra?|kr|avenida|av|avda|diagonal|dg|diag|transversal|tv|trans|transv|autopista|circular|circ|v[ií]a|km|kil[oó]metro|manzana|mz|vereda|corregimiento|sector)(?!\p{L})/iu;

/**
 * La dirección tiene números pero no dice el tipo de vía («La 42 con
 * 83E-15», «42 # 83-15»): el mapa puede ubicarla en otro lado. El
 * restaurante la confirma antes de cotizar. Un lugar con nombre y sin
 * números («Clínica Farallones») no entra aquí.
 */
export function ambiguousAddress(address: string | null | undefined): boolean {
  if (!address || !/\d/.test(address)) return false;
  // «Conjunto Bosques del Lili, 3» o «Unicentro local 12»: el número no es de la calle.
  const street = address.replace(/\b(local|apto|apartamento|torre|bloque|casa|piso|oficina|of|interior|int)\b\.?\s*#?\s*\w+/giu, "");
  return /\d/.test(street) && !ROAD_TYPE.test(street);
}

// ---------------------------------------------------------------------------
// La puerta (torre, apto, casa…) aparte de la dirección que va al mapa
// ---------------------------------------------------------------------------

/** Lo que identifica una puerta dentro de un conjunto, edificio o calle:
 *  «Torre 4», «Apto 803», «Bloque C», «Casa 14», «Local 5», «Piso 3». */
const DOOR_WORD = String.raw`(?:interior|torre|bloque|bl|manzana|mz|apartamento|apto|apt|ap|casa|piso|oficina|ofc|of|local|loc|lote|int)`;
/** Lo que sigue a la palabra: un número («4», «803», «12B», «4-803», «C202») o una
 *  sola letra en mayúscula («Torre A»). «Torre Alta» o «Casa Blanca» no: es un nombre. */
const DOOR_ID = String.raw`(?:n[°º]\.?\s*|no\.?\s*|#\s*)?(\p{L}?\p{N}{1,4}\p{L}?(?:\s*-\s*\p{N}{1,4})?|\p{Lu})`;
const DOOR_RE = new RegExp(String.raw`(?<![\p{L}\p{N}])(${DOOR_WORD})(?!\p{L})\.?\s*${DOOR_ID}(?![\p{L}\p{N}])`, "giu");

/** Los que cuentan como conjunto o edificio: con ellos, la dirección es de varias familias. */
const MULTI_UNIT_DOOR = /^(torre|bloque|bl|interior|int|apartamento|apto|apt|ap)$/iu;

const squashText = (t: string) => t.toLowerCase().replace(/[^a-z0-9]/g, "");

const TRIM_EDGES = /^[\s,;.\-–]+|[\s,;.\-–]+$/g;

/**
 * Separa la puerta de la dirección: «Unidad Reserva campestre, Torre 4 Apto
 * 803» → dirección «Unidad Reserva campestre», puerta «Torre 4 Apto 803». La
 * puerta es lo que el motorizado usa adentro; al mapa solo va el conjunto, el
 * edificio o la calle. No depende de lo que haya hecho el modelo.
 *
 * Una palabra de puerta sin número («Edificio Torre Alta», «Casa Blanca») es
 * un nombre y se queda. Con `all`, también una puerta al comienzo («Local 3,
 * Cra 50 # 10-20»): para buscar en el mapa, donde nunca ayuda; al guardar la
 * entrega se deja como llegó. Si no queda dirección, no separa nada.
 */
export function splitDoor(address: string | null | undefined, { all = false } = {}): { direccion: string; detalle: string | null; multiUnit: boolean } {
  const text = (address ?? "").replace(/\s+/g, " ").trim();
  const none = { direccion: text, detalle: null, multiUnit: false };
  if (!text) return none;

  const found = [...text.matchAll(DOOR_RE)].filter((m) => {
    const id = m[2] ?? "";
    // Una sola letra solo si va en mayúscula («Torre A»): «casa a la esquina» no es una puerta.
    return !(id.length === 1 && /\p{L}/u.test(id) && id !== id.toUpperCase());
  });
  if (!found.length) return none;

  // Las puertas pegadas («Torre 4, Apto 803») son una sola.
  const runs: { start: number; end: number; parts: string[]; words: string[] }[] = [];
  for (const m of found) {
    const start = m.index!;
    const end = start + m[0].length;
    const last = runs[runs.length - 1];
    if (last && /^[\s,.\-–]*$/.test(text.slice(last.end, start))) {
      last.end = end;
      last.parts.push(m[0]);
      last.words.push(m[1]);
    } else runs.push({ start, end, parts: [m[0]], words: [m[1]] });
  }

  // Al comienzo, «Torre 2 del Conjunto…» o «Local 3, Cra 50…» es parte del nombre o de la
  // dirección; «Torre 4 Apto 803, Unidad Reserva campestre» no: es la puerta, dicha primero.
  const leadingDoor = (r: (typeof runs)[number]) => r.words.some((w) => MULTI_UNIT_DOOR.test(w)) && !/^[\s,]*(?:de|del)\s/iu.test(text.slice(r.end));
  const taken = runs.filter((r) => all || r.start > 0 || leadingDoor(r));
  if (!taken.length) return none;

  let rest = "";
  let at = 0;
  for (const r of taken) {
    rest += text.slice(at, r.start);
    at = r.end;
  }
  rest += text.slice(at);
  rest = rest
    .replace(/\s+([,;])/g, "$1")
    .replace(/([,;])\s*(?:[,;]\s*)+/g, "$1 ")
    .replace(/\s+/g, " ")
    .replace(TRIM_EDGES, "")
    .replace(/^(?:de|del|la|el)\s+/iu, "")
    // «Cra 5 # 4-3 y» / «Cra 5 # 4-3 en»: lo que quedó colgando.
    .replace(/\s+(?:y|en|de|del|con|para|al?)$/iu, "");
  // Tiene que quedar una dirección: palabras («Unidad Reserva») o un número largo, no solo «# 4».
  if (!/\p{L}{2,}/u.test(rest) && !/\p{N}{3,}/u.test(rest)) return none;

  const detail = taken
    .flatMap((r) => r.parts)
    // «apto803» → «apto 803»
    .map((p) => p.replace(TRIM_EDGES, "").replace(/^(\p{L}+)(?=\p{N})/u, "$1 "))
    .join(" ");
  const detalle = detail ? detail.charAt(0).toUpperCase() + detail.slice(1) : null;
  return { direccion: rest, detalle, multiUnit: taken.some((r) => r.words.some((w) => MULTI_UNIT_DOOR.test(w))) };
}

/** Las dos puertas, sin repetir lo que ya dice la otra: «Apto 803» y «Torre 4 Apto 803» es la segunda. */
function joinDoors(known: string | null | undefined, found: string | null): string | null {
  if (!found) return known?.trim() || null;
  if (!known?.trim()) return found;
  if (squashText(known).includes(squashText(found))) return known.trim();
  if (squashText(found).includes(squashText(known))) return found;
  return `${found} ${known.trim()}`;
}

/**
 * La torre, el apartamento o la casa que el modelo dejó dentro de
 * `direccionEntrega` pasan completos a `detalleDireccion` (sin repetirse si ya
 * estaban ahí). La dirección conserva el conjunto, el edificio o la calle.
 */
export function separateDoor<F extends Pick<DeliveryFields, "direccionEntrega" | "detalleDireccion" | "esConjunto">>(fields: F): F {
  const split = splitDoor(fields.direccionEntrega);
  if (!split.detalle) return fields;
  return {
    ...fields,
    direccionEntrega: split.direccion,
    detalleDireccion: joinDoors(fields.detalleDireccion, split.detalle),
    esConjunto: fields.esConjunto ?? (split.multiUnit ? true : null),
  };
}

// ---------------------------------------------------------------------------
// Preguntar el precio a un conjunto o lugar por su nombre
// ---------------------------------------------------------------------------

/** Lo que dice que lo que sigue es un conjunto o un lugar y no una calle. */
const PLACE_WORD = String.raw`(?:unidad|conjunto|conj|edificio|edif|edf|condominio|urbanizaci[oó]n|agrupaci[oó]n|ciudadela|torres|residencial|centro\s+comercial|c\.?\s?c\.?)(?![\p{L}\p{N}])`;
const NAMED_PLACE = new RegExp(String.raw`^${PLACE_WORD}`, "iu");
const PRICE_TO_PLACE = new RegExp(String.raw`(?<![\p{L}\p{N}])(?:hasta|para|a|al)\s+(?:la\s+|el\s+|los\s+|las\s+)?(?=${PLACE_WORD})(.+?)\s*[?¿!.,]*$`, "iu");

/** «qué cuesta hasta…», «cuánto vale a…», «precio hasta…», «cuánto cobran para…». */
const PRICE_ASK =
  /(?<![\p{L}\p{N}])(?:(?:cu[aá]nto|qu[eé]|cu[aá]l)\s+(?:cuesta|vale|cobran|cobra|sale|ser[ií]a|es\s+(?:el\s+)?(?:precio|valor))|precio|valor\s+del\s+domicilio|cot[ií]za(?:me|r|ci[oó]n)?)(?![\p{L}\p{N}])/iu;

/**
 * El conjunto o lugar por el que solo se pregunta el precio, con su nombre:
 * «hola buenas que cuesta hasta la unidad de reserva campestre ?» → «Unidad de
 * reserva campestre». `null` si no es una pregunta de precio a un lugar con nombre
 * (a una calle con número la lee el modelo sin problema).
 */
export function priceQuestionPlace(text: string | null | undefined): string | null {
  const flat = (text ?? "").replace(/\s+/g, " ").trim();
  if (!flat || !PRICE_ASK.test(flat)) return null;
  const place = PRICE_TO_PLACE.exec(flat)?.[1]?.replace(/[?¿!]+/g, "").trim();
  if (!place || !NAMED_PLACE.test(place) || place.split(" ").length < 2) return null;
  return place.charAt(0).toUpperCase() + place.slice(1);
}

/**
 * El modelo a veces marca «confuso» (o no devuelve la dirección) cuando solo se
 * pregunta el precio a un conjunto por su nombre: una cotización normal. Si el
 * mensaje lo es y trae un lugar con nombre, la entrega es ese lugar y no hay
 * nada confuso. No toca nada si el modelo sí leyó una dirección y no dudó.
 */
export function rescuePriceQuestion(
  text: string,
  entregas: Interpretation["entregas"],
  confused: boolean,
): { entregas: Interpretation["entregas"]; confused: boolean; rescued: boolean } {
  const place = priceQuestionPlace(text);
  if (!place) return { entregas, confused, rescued: false };
  const hasAddress = entregas.some((e) => e.direccionEntrega);
  if (hasAddress) return { entregas, confused: false, rescued: confused };
  const blank = entregas.findIndex((e) => !e.direccionEntrega);
  const next = [...entregas];
  const found = { ...(blank >= 0 ? next[blank] : emptyDelivery()), direccionEntrega: place, esConjunto: true };
  if (blank >= 0) next[blank] = found;
  else next.push(found);
  return { entregas: next, confused: false, rescued: true };
}

/** La dirección tal como la lee el motorizado: calle y, si hay, torre y apto. */
export function fullAddress(delivery: Pick<DeliveryDraft, "direccionEntrega" | "detalleDireccion">): string {
  const { direccionEntrega: street, detalleDireccion: detail } = delivery;
  // El modelo a veces deja la torre o la casa también en la dirección: no se repite.
  const squash = (t: string) => t.toLowerCase().replace(/[^a-z0-9]/g, "");
  if (!detail || (street && squash(street).includes(squash(detail)))) return street ?? "";
  return [street, detail].filter(Boolean).join(" · ");
}

/** «Datáfono», «lleve datáfono», «paga con tarjeta», «tarjeta»: el cliente
 *  paga con tarjeta al recibir. */
const CARD_ON_DELIVERY = /(?<![\p{L}\p{N}])(?:dat[aá]fono|tarjeta|cr[eé]dito\s+o\s+d[eé]bito)(?![\p{L}\p{N}])/iu;
/** Lo que dice que ya está pagado, aunque mencione la tarjeta («pagó con
 *  tarjeta por la página»). */
const ALREADY_PAID =
  /(?<![\p{L}\p{N}])(?:ya\s+(?:est[aá]\s+)?pagad[oa]|pag[oó]\s+(?:con\s+tarjeta\s+)?(?:por|en)\s+(?:la\s+)?(?:p[aá]gina|app|web|link|rappi|nequi|daviplata)|ya\s+pag[oó]|pagad[oa]\s+con\s+tarjeta)(?![\p{L}\p{N}])/iu;

/** ¿El mensaje dice que el cliente paga con datáfono? */
export function mentionsCardOnDelivery(text: string): boolean {
  return CARD_ON_DELIVERY.test(text) && !ALREADY_PAID.test(text);
}

/**
 * Corrige el método de pago que leyó el modelo con lo que dice el mensaje:
 * «tarjeta» o «datáfono» se leían como «ya pagado» y al domiciliario le
 * llegaba «no cobres». Si el mensaje habla del datáfono, una entrega marcada
 * como transferencia pasa a datáfono, y si el mensaje trae una sola entrega
 * sin método, también. Lo que el restaurante no dijo no se llena.
 */
export function fixPaymentMethod<D extends { metodoPago: PaymentMethod | null }>(entregas: D[], messageText: string): D[] {
  if (!mentionsCardOnDelivery(messageText)) return entregas;
  return entregas.map((e) =>
    e.metodoPago === "transferencia" || (e.metodoPago === null && entregas.length === 1) ? { ...e, metodoPago: "datafono" as const } : e,
  );
}

/** "efectivo requiere retorno a base" (prompt maestro §A): la plata que
 *  cobra el motorizado no es suya, hay que liquidarla — a diferencia de una
 *  transferencia, que ya le llegó directo al restaurante o a la agencia. */
export function requiresCashReturn(metodoPago: PaymentMethod | null): boolean {
  return metodoPago === "efectivo";
}

/** Cuántos datos trae el pedido: sirve para saber si un mensaje aportó algo. */
export function countFields(draft: OrderDraft): number {
  const own = draft.origenRestaurante != null ? 1 : 0;
  return own + draft.entregas.reduce((n, d) => n + DELIVERY_KEYS.filter((k) => d[k] != null).length, 0);
}

function mergeDelivery(known: DeliveryDraft, incoming: DeliveryFields): DeliveryDraft {
  const merged: DeliveryDraft = { ...known };
  // La dirección ya ubicada, reescrita por el modelo con las mismas palabras en
  // otro orden, no es una corrección: se conserva, y con ella el punto exacto
  // del pin (si no, se vuelve a buscar en el mapa).
  const rewritten = !!known.ubicacionEntrega && sameWords(known.direccionEntrega, incoming.direccionEntrega);
  for (const key of DELIVERY_KEYS) {
    if (key === "notas" || (key === "direccionEntrega" && rewritten)) continue;
    const value = incoming[key];
    if (value != null) (merged as Record<string, unknown>)[key] = value;
  }
  if (incoming.barrio) merged.barrio = incoming.barrio;
  // La segunda dirección del ticket: llega con la lectura, y se va cuando el
  // restaurante dice cuál es (la dirección cambia sin otra alterna).
  if (incoming.direccionAlterna) merged.direccionAlterna = incoming.direccionAlterna;
  else if (incoming.direccionEntrega != null && incoming.direccionEntrega !== known.direccionEntrega) merged.direccionAlterna = null;
  // Eligió la otra: el modelo a veces las intercambia en vez de soltar la que no va.
  if (known.direccionAlterna && incoming.direccionEntrega && !sameAddress(incoming.direccionEntrega, known.direccionEntrega) && sameAddress(merged.direccionAlterna ?? null, known.direccionEntrega)) {
    merged.direccionAlterna = null;
  }
  if (merged.direccionAlterna && sameAddress(merged.direccionAlterna, merged.direccionEntrega)) merged.direccionAlterna = null;
  // Un dato que llega de nuevo (una corrección) deja de ser dudoso, salvo que
  // el modelo vuelva a dudar de él.
  const corrected = (k: DoubtfulField) => incoming[k] != null && incoming[k] !== known[k];
  const doubts = new Set<DoubtfulField>([...(known.dudas ?? []).filter((k) => !corrected(k)), ...(incoming.dudas ?? [])]);
  merged.dudas = doubts.size ? [...doubts] : null;
  const notes = [known.notas, incoming.notas].filter((n): n is string => !!n?.trim());
  merged.notas = notes.length ? [...new Set(notes)].join(" · ") : null;
  return merged;
}

/**
 * La memoria del pedido: lo que ya se sabía más lo que trajo el mensaje
 * nuevo. El modelo devuelve la lista completa de entregas hasta ahora, en el
 * mismo orden: la entrega N del mensaje se junta con la N que ya había, y
 * una de más es una entrega nueva, salvo que sea una que ya estaba
 * (`sameDelivery`). Un dato nuevo no nulo gana (es una corrección o un dato
 * que faltaba); un `null` nuevo NUNCA borra lo que ya se tenía, y una entrega
 * que el modelo "olvide" tampoco se pierde. Que lo garantice el código y no
 * el modelo. Quitar una entrega es aparte y explícito: `removeDeliveries`.
 */
export function mergeTripFields(known: OrderDraft, incoming: Interpretation): OrderDraft {
  const fields = incoming.entregas.map(doorAsDetail);
  const entregas = known.entregas.map((base, i) => (fields[i] ? mergeDelivery(base, fields[i]) : base));
  for (const extra of fields.slice(known.entregas.length)) {
    // «el de la comuna 16, nombre Ramiro»: nombra una entrega que ya estaba por
    // como el bot la mostró. Sus datos van a esa; la dirección no cambia.
    const named = entregas.findIndex((d) => namedByLabel(d, extra));
    if (named !== -1) {
      entregas[named] = mergeDelivery(entregas[named], { ...extra, direccionEntrega: null, barrio: null });
      continue;
    }
    let twin = -1;
    for (let i = entregas.length - 1; i >= 0 && twin === -1; i--) if (sameDelivery(entregas[i], extra)) twin = i;
    if (twin === -1) entregas.push(mergeDelivery(emptyDelivery(), extra));
    else entregas[twin] = mergeDelivery(entregas[twin], extra);
  }
  return {
    ...known,
    origenRestaurante: incoming.origenRestaurante ?? known.origenRestaurante,
    entregas,
  };
}

/** Solo la puerta: «casa 14», «Torre 4 apto 902», «apto 1203». Sin vía,
 *  número de placa, conjunto ni barrio. */
const DOOR_ONLY = /^(casa|apto|apartamento|apt|torre|bloque|interior|int|piso|oficina|of|local)\b[\s\w.-]*$/i;
const STREET = /\b(calle|cl|carrera|cra|kr|cr|avenida|av|diagonal|dg|transversal|tv|conjunto|edificio|unidad|barrio|urbanizaci[oó]n)\b|#/i;

/**
 * El modelo a veces pone la puerta como dirección («Ana 300…, casa 14»): eso
 * sobrescribía la dirección de la entrega o armaba otro pedido. Va a
 * `detalleDireccion`, que es lo que es.
 */
function doorAsDetail(fields: DeliveryFields): DeliveryFields {
  const address = fields.direccionEntrega?.trim();
  const only = !address || !DOOR_ONLY.test(address) || STREET.test(address) ? fields : { ...fields, direccionEntrega: null, detalleDireccion: fields.detalleDireccion ?? address };
  const moved = separateDoor(only);
  // Y la puerta repetida en las notas («Para Torre 4 apto 902») no le dice nada nuevo al domiciliario.
  const door = moved.detalleDireccion ? normalizeName(moved.detalleDireccion) : null;
  const note = moved.notas ? normalizeName(moved.notas).replace(/^(para|en|a)\s+(la\s+|el\s+)?/, "") : null;
  return door && note === door ? { ...moved, notas: null } : moved;
}

/** Una dirección dice lo mismo que la otra: todas sus palabras están en ella
 *  (otro orden, sin la ciudad o el código postal). */
function sameWords(known: string | null, incoming: string | null) {
  if (!known || !incoming) return false;
  const words = new Set(normalizeName(known).split(" "));
  return normalizeName(incoming)
    .split(" ")
    .every((w) => words.has(w));
}

/** La misma dirección, aunque cambien mayúsculas, tildes o signos. */
function sameAddress(a: string | null, b: string | null) {
  return !!a && !!b && normalizeName(a) === normalizeName(b);
}

/** Lo que distingue a un cliente de otro en la misma dirección. */
const CUSTOMER_KEYS = ["nombreCliente", "telefonoCliente", "detalleDireccion"] as const;

/**
 * ¿La entrega de más que devolvió el modelo es una que ya estaba? Pasa cuando
 * los datos del cliente llegan después de la dirección o del pin: con «Marta
 * Ríos 300…, para torre 4 apto 902» el modelo a veces arma otro pedido a la
 * misma dirección. Es la misma si trae la misma dirección (o ninguna) y ningún
 * dato del cliente distinto. Dos clientes del mismo conjunto siguen siendo dos:
 * su nombre, su teléfono o su apartamento no coinciden.
 */
function sameDelivery(known: DeliveryDraft, extra: DeliveryFields) {
  if (extra.direccionEntrega != null && !sameAddress(known.direccionEntrega, extra.direccionEntrega)) return false;
  return CUSTOMER_KEYS.every((k) => known[k] == null || extra[k] == null || normalizeName(String(known[k])) === normalizeName(String(extra[k])));
}

/** Cómo se nombra una entrega en los mensajes del bot: su barrio o la
 *  primera parte de la dirección. Una comuna («Comuna 16», lo que a veces
 *  devuelve el mapa) no le dice nada al restaurante: va la dirección. */
export function deliveryLabel(delivery: Pick<DeliveryDraft, "barrio" | "direccionEntrega">): string {
  const barrio = delivery.barrio && !/^comuna\s*\d+$/i.test(delivery.barrio.trim()) ? delivery.barrio : null;
  return barrio ?? delivery.direccionEntrega?.split(",")[0] ?? "la entrega";
}

/** Los nombres con que el restaurante puede referirse a una entrega: el que
 *  le mostró el bot, su barrio (aunque sea una comuna) y el comienzo de la dirección. */
function labelsOf(d: Pick<DeliveryDraft, "barrio" | "direccionEntrega">): string[] {
  return [deliveryLabel(d), d.barrio, d.direccionEntrega?.split(",")[0], d.direccionEntrega]
    .filter((l): l is string => !!l?.trim())
    .map(normalizeName)
    .filter((l) => l.length >= 3);
}

/**
 * ¿La entrega de más solo nombra una que ya estaba? Su «dirección» es una
 * palabra sin número que coincide con cómo se llama esa entrega («Comuna 16»,
 * «Pance»), y no trae un cliente distinto. Una dirección de verdad (con
 * número) es otra entrega.
 */
function namedByLabel(known: DeliveryDraft, extra: DeliveryFields) {
  const said = extra.direccionEntrega ? normalizeName(extra.direccionEntrega) : null;
  if (!said || /\d/.test(said.replace(/^comuna\s*\d+$/, "comuna")) || !known.direccionEntrega) return false;
  if (!labelsOf(known).some((l) => l === said)) return false;
  return CUSTOMER_KEYS.every((k) => known[k] == null || extra[k] == null || normalizeName(String(known[k])) === normalizeName(String(extra[k])));
}

/**
 * Lo que el modelo leyó de UN ticket, como una sola entrega. A veces parte el
 * bloque de la dirección en varias entregas («Kra 10…» con el teléfono, y
 * aparte «Unidad Las Palmas, Torre 4 apt 106» sin cliente). Si solo una trae al
 * cliente (nombre o teléfono), los trozos sin cliente son parte de ella: una
 * dirección con número que no estaba va como `direccionAlterna` (se pregunta a
 * cuál va); un nombre de conjunto o una puerta se suman a la suya.
 */
export function foldTicket<F extends DeliveryFields>(entregas: F[]): F[] {
  const withCustomer = entregas.filter((e) => e.nombreCliente || e.telefonoCliente);
  if (entregas.length < 2 || withCustomer.length !== 1) return entregas;
  const owner: F = { ...withCustomer[0] };
  for (const piece of entregas) {
    if (piece === withCustomer[0]) continue;
    const address = piece.direccionEntrega?.trim() || null;
    const door = piece.detalleDireccion?.trim() || null;
    if (address && /\d/.test(address) && !(owner.direccionEntrega && sameWords(owner.direccionEntrega, address))) {
      const full = [address, door].filter(Boolean).join(", ");
      if (!owner.direccionAlterna) owner.direccionAlterna = full;
      else if (!sameWords(owner.direccionAlterna, address)) owner.direccionAlterna = `${owner.direccionAlterna}, ${full}`;
      continue;
    }
    if (address && !(owner.direccionEntrega && normalizeName(owner.direccionEntrega).includes(normalizeName(address)))) {
      owner.direccionEntrega = owner.direccionEntrega ? `${owner.direccionEntrega}, ${address}` : address;
    }
    if (door && !owner.detalleDireccion) owner.detalleDireccion = door;
    if (piece.esConjunto) owner.esConjunto = true;
    if (piece.notas) owner.notas = [owner.notas, piece.notas].filter(Boolean).join(" · ");
  }
  return [owner];
}

/**
 * La respuesta a «¿a cuál va?» escrita en vez de con el botón: «la segunda»,
 * «la 1», «la de Las Palmas», «la de la avenida». 1, 2 o `null` si no queda claro.
 * Por palabras o números que solo tiene una de las dos.
 */
export function pickAlternative(text: string | null | undefined, d: Pick<DeliveryDraft, "direccionEntrega" | "detalleDireccion" | "direccionAlterna">): 1 | 2 | null {
  if (!text || !d.direccionAlterna || !d.direccionEntrega) return null;
  const t = normalizeName(text);
  if (/\b(la|el)\s+(segunda|segundo|2|dos|otra|ultima|de abajo)\b|^(2|dos|segunda|la 2)$/.test(t)) return 2;
  if (/\b(la|el)\s+(primera|primero|1|uno|de arriba)\b|^(1|uno|primera|la 1)$/.test(t)) return 1;
  // Por palabras solo en una respuesta corta: en un mensaje largo con más datos
  // («lista en 10») un número suelto no dice cuál.
  if (t.split(" ").length > 8) return null;
  const words = (s: string) => new Set(normalizeName(s).split(" ").filter((w) => (/^\p{L}+$/u.test(w) && w.length >= 4) || /^\d{3,}/.test(w)));
  const first = words([d.direccionEntrega, d.detalleDireccion].filter(Boolean).join(" "));
  const second = words(d.direccionAlterna);
  const said = t.split(" ");
  const inFirst = said.some((w) => first.has(w) && !second.has(w));
  const inSecond = said.some((w) => second.has(w) && !first.has(w));
  return inFirst === inSecond ? null : inSecond ? 2 : 1;
}

const ORDINAL: Record<string, number> = { primer: 1, primero: 1, primera: 1, segundo: 2, segunda: 2, tercer: 3, tercero: 3, tercera: 3, "1": 1, "2": 2, "3": 3 };

/**
 * «nono solo necesito el de la comuna 16», «solo el segundo», «solo va el de
 * Pance»: de todas las entregas se queda una. Devuelve las posiciones (desde 1)
 * de las demás, o [] si no lo dice o no queda claro cuál. Es la red en código
 * de `quitar`: el modelo a veces lo lee como una entrega nueva.
 */
export function onlyOneOf(text: string | null | undefined, entregas: Pick<DeliveryDraft, "barrio" | "direccionEntrega">[]): number[] {
  if (!text || entregas.length < 2) return [];
  const t = normalizeName(text);
  const m = t.match(/\bsolo\s+(?:(?:necesito|quiero|es|era|va|vale|seria|pido|mando|me sirve|dejame|deja)\s+)?(?:el|la)\s+(.+)$/);
  if (!m) return [];
  const rest = m[1].replace(/^(?:de\s+la|del|de)\s+/, "");
  let keep = -1;
  const ordinal = rest.match(/^(?:numero\s+)?(primer|primero|primera|segundo|segunda|tercer|tercero|tercera|[123])\b/);
  if (ordinal) keep = ORDINAL[ordinal[1]] - 1;
  else {
    const hits = entregas.map((d, i) => (labelsOf(d).some((l) => rest.startsWith(l) || (rest.length >= 4 && l.startsWith(rest.split(" ").slice(0, 3).join(" ")))) ? i : -1)).filter((i) => i !== -1);
    if (hits.length === 1) keep = hits[0];
  }
  if (keep < 0 || keep >= entregas.length) return [];
  return entregas.map((_, i) => i + 1).filter((p) => p !== keep + 1);
}

/**
 * Quita las entregas que el restaurante pidió quitar («solo es 1», «el de
 * Pance ya no va»), por posición desde 1. Nunca todas: cancelar el pedido
 * entero lo resuelve la central. Lo que tenía una que se quita y le falta a
 * otra con la misma dirección pasa a esa: con el pin en una entrega y los
 * datos del cliente en otra, «solo es 1» deja una sola, completa.
 */
export function removeDeliveries(draft: OrderDraft, positions: number[]): { draft: OrderDraft; removed: boolean } {
  const drop = new Set(positions.filter((p) => Number.isInteger(p) && p >= 1 && p <= draft.entregas.length).map((p) => p - 1));
  if (!drop.size || drop.size >= draft.entregas.length) return { draft, removed: false };
  const kept = draft.entregas.filter((_, i) => !drop.has(i)).map((d) => ({ ...d }));
  for (const i of drop) {
    const gone = draft.entregas[i];
    let twin: DeliveryDraft | undefined;
    for (let k = kept.length - 1; k >= 0 && !twin; k--) if (sameAddress(kept[k].direccionEntrega, gone.direccionEntrega)) twin = kept[k];
    if (!twin) continue;
    const target = twin as Record<string, unknown>;
    for (const [key, value] of Object.entries(gone)) if (target[key] == null && value != null) target[key] = value;
  }
  return { draft: { ...draft, entregas: kept }, removed: true };
}

/** Cuántas veces se repregunta antes de pasar el pedido a una persona. */
export const MAX_CLARIFICATION_ATTEMPTS = 2;

export const ESCALATION_MESSAGE = "Te transferiré con un asesor de la central para gestionar tu pedido.";

/** El prompt de interpretación. El precio no sale de aquí: se cobra por
 *  distancia con la dirección ubicada en el mapa. */
export function buildExtractionPrompt() {
  return `Eres el asistente de despacho de una agencia de domicilios en Cali. Un restaurante te escribe por WhatsApp, en texto libre y desordenado, para cotizar o pedir motos. Puede mandar el pedido en varios mensajes, reenviar mensajes de su cliente, escribir muy corto ("en 10", "ya está") o pedir varios domicilios a la vez.

Recibes los "Datos ya capturados" del pedido en curso (con su "etapa": "recibiendo", "cotizado" si ya se le mandó el precio, "confirmado" si ya confirmó) y el "Mensaje nuevo". Devuelve SOLO este JSON, con el pedido COMPLETO hasta ahora:

{
  "origenRestaurante": string | null,   // dónde se recoge, si lo dice (nombre, dirección y barrio)
  "nombreRestaurante": string | null,   // el nombre del NEGOCIO QUE ESCRIBE, solo si el mensaje nuevo se identifica así a propósito ("soy de Pizza Nona", "habla Donde Lucho", "te escribo de Sushi Ya"), sin dirección. null si el mensaje no dice que el negocio es quien escribe: un nombre tras "domi", "domicilio", "moto", "llevar", "a", "para" o "al lado de" es a dónde va el pedido o una referencia ("domi para Café Luna, Calle 3 # 4-5", "domicilio a Café Luna", "al lado de Café Luna"), o si es el de una persona o del cliente. Ante la duda, null
  "entregas": [                         // una por cada cliente final, en el mismo orden de los datos ya capturados; también la dirección o el lugar por el que solo pregunta el precio
    {
      "direccionEntrega": string | null,  // calle y número (o el lugar conocido), nombre del conjunto o edificio, barrio y municipio si dice otro distinto de Cali ("Jamundí", "Yumbo", "Candelaria", "Palmira"); SIN torre ni apto (van en detalleDireccion) y SIN puntos de referencia (van en notas)
      "telefonoCliente": string | null,   // solo dígitos
      "nombreCliente": string | null,
      "valorACobrar": number | null,      // lo que el motorizado le cobra al cliente, en pesos
      "metodoPago": "efectivo" | "transferencia" | "datafono" | null,
      "listoEnMinutos": number | null,    // en cuántos minutos está lista la comida; 0 si ya está lista
      "notas": string | null,             // solo lo NUEVO de este mensaje que el motorizado deba saber
      "detalleDireccion": string | null,  // torre, bloque, apartamento, casa, piso, oficina o local: "Torre 3 apto 502"
      "esConjunto": boolean | null,       // true si la dirección es un conjunto, unidad, edificio, condominio o torres
      "barrio": string | null,            // el barrio del CLIENTE ("Bochalema", "Cañasgordas"), aunque venga dentro de la dirección; no la comuna ni el barrio del restaurante; null si no se sabe
      "dudas": string[],                  // nombres de los campos de ESTA entrega que leíste pero no estás seguro; [] si ninguno
      "direccionAlterna": string | null   // SOLO si un ticket trae DOS direcciones distintas para este mismo cliente y nada dice cuál es: la segunda, completa (ver reglas)
    }
  ],
  "quitar": number[],                   // posiciones (1 = la primera) de las entregas YA CAPTURADAS que el restaurante pide sacar del pedido; [] si ninguna
  "consulta": "estado" | "cobertura" | null,
  "reclamo": { "motivo": "datafono" | "plata" | null, "cierra": boolean } | null,
  "encargo": boolean,
  "cancelar": boolean,
  "intencion": "cotizar" | "pedir" | null,
  "confirma": boolean,
  "confuso": boolean
}

Reglas:
- Cada cliente final con su propia dirección es una entrega aparte. Dos direcciones = dos entregas, aunque lleguen en el mismo mensaje.
- Conserva las entregas ya capturadas, en su orden. NUNCA devuelvas menos entregas de las capturadas.
- Una dirección nueva que el restaurante presenta como OTRO pedido ("y otro para…", "también a…", datos de un segundo cliente) se agrega al final.
- Una CORRECCIÓN ("perdón, era…", "me equivoqué…", "la dirección correcta es…", "el de Pance es…", "no, es la…") NO agrega una entrega: reemplaza la dirección de la entrega que corrige, y la lista queda del mismo tamaño. Si no dice cuál corrige y hay varias, corrige la última.
  Ejemplo: capturadas [El Caney, Pance]; mensaje "perdón, el de Pance es Cra 105 # 14-30, Ciudad Jardín" → [El Caney, Cra 105 # 14-30, Ciudad Jardín].
- La MISMA dirección repetida (aunque esté escrita un poco distinto o venga con datos nuevos como torre, apto o tiempo) es la misma entrega: complétala, no agregues otra.
  Ejemplo: capturada [Conjunto Los Pinos, Cl 15 Nte # 8, sin datos del cliente]; mensaje "listo en 10, Ana Ruiz 3001234567 para torre 4 apto 902" → una sola entrega: Conjunto Los Pinos con Ana Ruiz, su teléfono, "Torre 4 apto 902" y 10 minutos. "Para torre 4 apto 902" dice a qué puerta va, no es otro pedido.
- Un dato suelto (solo un teléfono, solo un nombre) va a la entrega que le falte; si todas lo tienen o no se sabe, a la última.
- Cada entrega capturada trae "comoLaNombro": el nombre con que el bot se la mostró al restaurante (su barrio, su comuna o el comienzo de la dirección). Si el restaurante la nombra así ("el de la comuna 16", "el de Pance", "la de Bellaterra"), habla de ESA entrega: NO es una dirección nueva ni otra entrega. Los datos que traiga (nombre, teléfono, tiempo) van a esa entrega, en su posición.
- "Solo necesito el de X", "nono, solo el de X", "solo va el de X", "solo el segundo", "era solo el de X": se queda la entrega X y las demás van en "quitar".
  Ejemplo: capturadas [1: Jamundí, 2: Calle 40 # 80-10, Los Cerezos (comoLaNombro "Comuna 16")]; mensaje "nono solo necesito el de la comuna 16, nombre del cliente Ramiro" → "entregas": [Jamundí sin cambios, Calle 40 # 80-10 con nombreCliente "Ramiro"], "quitar": [1].
- Un ticket o factura que trae DOS direcciones distintas para el MISMO cliente (un solo nombre y teléfono; la caja imprimió dos, o el cliente tiene dos guardadas) es UNA entrega, no dos, y NUNCA mezcles partes de una con la otra: cada dirección va completa, con su número, su conjunto o barrio y su torre y apto.
  Si el texto del restaurante señala cuál es (nombra el conjunto, el barrio o la calle de una: "Las Palmas", "la de la avenida"), usa esa en "direccionEntrega" y "direccionAlterna" null.
  Si nada dice cuál, la primera en "direccionEntrega" (con su torre y apto en "detalleDireccion") y la otra completa, con su torre y apto, en "direccionAlterna".
  Ejemplo: ticket con "Calle 5#66-20 Los Robles Torre 4 apt 106 Unidad Las Palmas Av 4 Norte#23-10 Torre 2 Apt 707" y el texto "Las Palmas" → direccionEntrega "Av 4 Norte # 23-10, Unidad Las Palmas", detalleDireccion "Torre 2 Apt 707", direccionAlterna null.
- Si una entrega capturada tiene "direccionAlterna" y el restaurante dice cuál es ("la segunda", "la de Las Palmas", "la de la avenida"), devuelve en "direccionEntrega" la elegida, completa (con su torre y apto en "detalleDireccion"), y "direccionAlterna" null.
- Un municipio solo, sin dirección ("¿llegan a Jamundí?", "domi para Palmira"), va tal cual en "direccionEntrega" ("Jamundí", "Palmira"): el código responde si se llega. No lo cambies por una dirección ni lo juntes con otra.
- "quitar": cuando el restaurante dice que sobra una entrega o que ya no va: "quita la 2", "el de Pance ya no va", "cancela el segundo", "solo es 1", "es uno solo", "no son dos". Pon la posición de las que sobran; si dice "solo es 1" sin decir cuál, las que repiten la dirección de otra o no tienen datos del cliente. Aun así devuelve en "entregas" todas las capturadas: el código las quita. [] si no pide quitar ninguna.
- El tiempo de preparación dicho sin señalar una entrega ("en 10", "ya están los 2") aplica a todas las entregas que no lo tengan.
- Preguntar el precio ("¿qué vale a…?", "¿cuánto a…?", "¿domis acá?") es una cotización normal: la dirección o el lugar SIEMPRE va en "entregas", aunque no traiga nada más, y no es confuso. Sin ella no hay con qué cotizar.
  Ejemplo: "¿Cuánto a la Cra 98 # 45-30 Valle del Lili?" → "entregas": [{"direccionEntrega": "Cra 98 # 45-30, Valle del Lili", el resto null}], "intencion": "cotizar", "consulta": null.
  Un conjunto, unidad, edificio o lugar conocido, solo con su nombre, es una dirección válida para cotizar (sin torre ni apto: eso se pide después, al pedir): "hola buenas que cuesta hasta la unidad de reserva campestre ?" → "entregas": [{"direccionEntrega": "Unidad Reserva Campestre", "esConjunto": true, el resto null}], "intencion": "cotizar", "confuso": false.
- Una línea "(Ubicación de WhatsApp: X)" es un pin que el restaurante mandó en ese punto del mensaje: es la dirección de la entrega de la que habla junto a él ("a esta", "para esta dirección", "aquí"). Usa X tal cual como su "direccionEntrega"; si esa entrega ya tenía una dirección escrita, el pin es su ubicación: deja la escrita.
- Un lugar conocido sirve como dirección de entrega: "Clínica Farallones", "Centro Comercial Aquarela, local 12", "Unicentro". Guárdalo tal cual.
- "Ya está pagado", "pagó por Nequi/transferencia", "pago Bancolombia", "Daviplata", "pagado a través de Rappi", "pagó con tarjeta por la página" o "total a cobrar $0" = "transferencia" (y "valorACobrar" null: no se le cobra nada al cliente).
- "Datáfono", "lleve datáfono", "llevar datáfono", "paga con tarjeta", "tarjeta", "crédito o débito" (sin decir que ya está pagado) = "datafono": el cliente paga con tarjeta al recibir y el domiciliario lleva el datáfono del restaurante. Si dice el valor, va en "valorACobrar".
- El método de pago solo se llena si el restaurante lo dice: nunca lo supongas ni lo preguntes.
- Fotos de facturas o comandas: lee los datos del domicilio (nombre, teléfono, dirección, barrio, pago). Los productos y precios del pedido no van en ningún campo. Los datos del restaurante que imprime la factura (su nombre, dirección, teléfono, NIT) NO son del cliente.
  UN ticket es UN pedido de UN cliente: devuelve UNA sola entrega, aunque la dirección ocupe varias líneas o el ticket la imprima dos veces. Las líneas con torre, apto, interior, unidad o conjunto son parte de la dirección de arriba, nunca otra entrega. "No. 0", "Int. 0" y similares son relleno de la caja: no van. Solo son dos entregas si el ticket trae dos clientes distintos (dos nombres o dos teléfonos de clientes).
  Si en el bloque de la dirección de ese único cliente hay DOS direcciones distintas (dos calles con su número), es la regla de "direccionAlterna": una en "direccionEntrega" y la otra completa en "direccionAlterna", sin repartirlas en entregas.
  Ejemplo de ticket: "Teléfono: 3001234567 / Calle 5#66-20 Los Robles / Torre 4 apt 106 Unidad Las Palmas / Av 4 Norte#23-10 / Torre 2 Apt 707 No. 0 Int. 0" (y el mismo bloque repetido abajo), sin texto del restaurante → UNA entrega: direccionEntrega "Calle 5 # 66-20, Los Robles, Unidad Las Palmas", detalleDireccion "Torre 4 apt 106", direccionAlterna "Av 4 Norte # 23-10, Torre 2 Apt 707", telefonoCliente "3001234567".
- "listoEnMinutos": "en 10", "listo en 15", "sale en 15 min" = ese número. "Ya está", "ya está listo", "pueden venir", "ya sale" = 0. Si da un rango ("10 a 15 min"), usa el menor. Si da una hora ("lista a las 7:40"), calcula los minutos desde la "Hora actual" que te paso. Si no dice nada del tiempo, null: nunca lo supongas.
- "detalleDireccion": SOLO lo que identifica la puerta (torre, bloque, interior, apartamento, casa, piso, oficina, local, o un código como "C202"); el barrio y las indicaciones ("dejar en portería") nunca van ahí. Copia completos la torre Y el apartamento: "Torre 1 apto 604" → "Torre 1 apto 604", nunca solo "Apto 604".  Si llega después en un mensaje suelto ("torre 2 apto 301", "casa 14"), va a la entrega que no lo tenga. No lo repitas en "direccionEntrega" ni en "notas" (si ya va en "valorACobrar" o "metodoPago", tampoco en notas), pero no quites de "direccionEntrega" nada más: el nombre del conjunto o edificio y el barrio se quedan ahí.
  Ejemplo: "Calle 5 # 66-20, Edificio Torre Alta apto 1203, El Refugio" → direccionEntrega "Calle 5 # 66-20, Edificio Torre Alta, El Refugio", detalleDireccion "Apto 1203", esConjunto true.
  Ejemplo con un conjunto por su nombre: "Unidad Reserva campestre, Torre 4 Apto 803" → direccionEntrega "Unidad Reserva campestre", detalleDireccion "Torre 4 Apto 803" (completo: la torre Y el apartamento), esConjunto true. La torre, el bloque, el interior, la manzana, el apartamento, la casa, el piso, la oficina y el local NUNCA se quedan en "direccionEntrega"; «Torre Alta» o «Casa Blanca» (sin número) sí, porque son el nombre del edificio.
- Puntos de referencia y descripciones del lugar ("frente a la panadería El Sebas", "al lado hay un puesto de arepas", "casa esquinera de rejas negras", "aquí me encuentro yo") NO van en "direccionEntrega": van en "notas", completos y bien redactados, porque son lo que el domiciliario usa para encontrar el sitio. Nunca los resumas ni los descartes.
  Ejemplo: "A nombre de Laura Gómez mi número 3001234567 dirección es por toda la 42 con 83E -15 panadería el Sebas. El punto de referencia es la panadería y justo al lado hay un puesto de arepas de choclo en toda una esquina. aquí me encuentro yo" → direccionEntrega "La 42 con 83E-15" (no dice si es calle o carrera: no lo inventes), nombreCliente "Laura Gómez", telefonoCliente "3001234567", notas "Punto de referencia: panadería El Sebas · Justo al lado hay un puesto de arepas de choclo, en la esquina · El cliente espera ahí".
- "esConjunto": true si la dirección nombra un conjunto, unidad residencial, edificio, condominio, torres o urbanización cerrada ("Conjunto Bosques del Lili", "Unidad Alameda", "Edificio Ceibas", "Torres de Comfandi"). false si es una casa en una calle, un local o un lugar público (clínica, centro comercial, universidad). También true si el restaurante menciona torre, bloque o apartamento aunque no dé el número. null si no se sabe. Conserva el valor ya capturado si el mensaje no dice nada nuevo de la dirección.
- "notas": TODO lo que le sirva al domiciliario y no tenga otro campo; no descartes nada útil aunque a la agencia no le importe: instrucciones de entrega, con cuánto paga el cliente ("billete de 100 mil"), si hay que llevar cambio o datáfono, qué lleva el pedido (bebidas, algo frágil o caliente), horarios, puntos de referencia y cómo es el lugar ("casa esquinera", "portón negro", "al lado de la panadería", "dejar en portería", "llamar al llegar"). Ordénalo en frases cortas separadas por " · ". No repitas lo que ya va en otro campo ni lo que ya estaba en las notas. Saludos, agradecimientos y los productos con sus precios no van.
- "intencion": qué quiere el restaurante con ESTE mensaje.
  "cotizar" = SOLO pregunta cuánto vale o si llegan, sin pedir que lo manden: "¿cuánto a Valle del Lili?", "¿qué vale un domi hasta Pance?", "¿cuánto cobran a la Cra 50 # 10-20?", "cotízame a…", "¿llegan a Jamundí y cuánto?".
  "pedir" = pide el servicio: manda el pedido o datos del cliente (nombre, teléfono, tiempo, valor, torre y apto), reenvía el pedido de su cliente, "necesito un domi para…", "envíame una moto", "para la Cra 50…", una dirección sola sin preguntar el precio, o decide mandar lo que ya cotizó ("dale, mándalo", "pídelo").
  null = ni lo uno ni lo otro (un saludo, "gracias", una consulta de estado). Si dudas entre "cotizar" y "pedir", "pedir".
- "confirma": true solo si la etapa es "cotizado" o "confirmado" y el restaurante acepta el servicio con palabras: "sí", "dale", "listo", "confirmo", "ya están los 2". Mandar datos o el tiempo de preparación no es confirmar. En la etapa "recibiendo", siempre false.
  Si en los datos ya capturados "soloPrecio" es true (solo preguntó el precio), confirma SOLO si decide mandarlo: "dale, mándalo", "pídelo", "sí, envíalo", "listo, que vaya" (si manda los datos del cliente o el tiempo, "intencion" es "pedir", pero no confirma). "Ok", "gracias", "vale", "ah bueno", "listo gracias" o "lo tengo en cuenta" son false.
- Nunca inventes un valor: lo que no sepas va en null.
- "dudas": los campos que SÍ leíste pero de los que no estás seguro: letra borrosa o cortada en una foto, un número con dígitos ilegibles o de menos (un celular colombiano tiene 10), dos lecturas posibles ("Cra 15" o "Cra 16"), un dato que no queda claro a qué entrega pertenece, o algo que no cuadra: una dirección sin tipo de vía ("la 42 con 83", no se sabe si es calle o carrera) o a medias (sin el número de la casa), dos teléfonos o dos nombres para el mismo cliente, un barrio que no corresponde a la dirección, o un dato distinto del ya capturado sin decir que es una corrección. Ante la duda, márcalo: el restaurante confirma antes de pedir la moto, y es mejor preguntar que mandar al domiciliario a otro lado. Pon tu mejor lectura en el campo y su nombre en "dudas" (solo estos nombres: "direccionEntrega", "detalleDireccion", "telefonoCliente", "nombreCliente", "valorACobrar", "metodoPago", "listoEnMinutos", "notas"). Lo que no se lee para nada va en null, no en "dudas". Un dato claro nunca va en "dudas".
- Si no hay entregas capturadas y el mensaje trae datos sueltos sin dirección ("ya está listo", "en 10", "paga con 50 mil", un teléfono), devuélvelos en UNA entrega con "direccionEntrega": null. "entregas" va vacío solo si el mensaje no trae ningún dato (un saludo, por ejemplo).
- "consulta": "estado" si pregunta por un pedido ya pedido ("¿ya llegó?", "¿ya va la moto?", "¿quién va?", "¿dónde va el domicilio?", "¿ya lo recogieron?", "¿cuál es el número del domiciliario?", "pásame el contacto del motorizado"). "cobertura" si pregunta si llegan a algún lugar ("¿domis acá?", "¿llegan a Jamundí?", "¿tienen servicio hasta Palmira?", "¿cubren Pance?"); ese lugar también va en "entregas". En otro caso, null. Preguntar el PRECIO a una dirección no es consulta: es una cotización normal.
- "reclamo": cuando el restaurante reclama que un domiciliario le devuelva su datáfono o le traiga la plata de pedidos anteriores, o avisa que ya va a cerrar ("¿a qué hora me traen la plata?", "necesito el datáfono", "ya vamos a cerrar, necesito la plata", "no me han devuelto el datáfono", "ya vamos a cerrar"). "motivo": "plata" si pide su plata/efectivo, "datafono" si pide su datáfono, o null si dice que va a cerrar o pide cuadrar sin especificar cuál. "cierra": true si dice que ya va a cerrar o está cerrando. NO es reclamo que un pedido nuevo diga "llevar datáfono" o "paga en efectivo" (eso es el metodoPago del cliente). Si en el mismo mensaje pide un domicilio y además hace un reclamo, llena TANTO "entregas"/"intencion" como "reclamo". Si no reclama nada ni avisa que cierra, null.
- "encargo": true si el restaurante NO pide llevar su comida a un cliente, sino que le COMPREN, CONSIGAN o TRAIGAN algo: "necesito que me compren un queso tajado en la salsamentaria", "de ir al Ara a comprar 3 paquetes de tortillas", "Necesito un domi" + foto de un envase + "me traes 30", "¿me pueden hacer una vuelta? comprar 2 aguacates en la frutería", "que vayan donde mi proveedor a recoger unas cajas y me las traigan". También si a un domicilio normal le agrega comprar algo en el camino ("y de camino le compras una gaseosa al cliente"). Mira también los datos ya capturados: si en un mensaje anterior pidió el domi y en este dice qué hay que comprar o traer, es encargo. En un encargo, la tienda o el lugar donde se compra o se recoge NO es una dirección de entrega: no lo pongas en "entregas".
  La clave es QUIÉN compra y DÓNDE: es encargo cuando el RESTAURANTE pide que el domiciliario compre o recoja algo en OTRO lugar (una tienda, el Ara, el D1, un supermercado, una droguería, la galería, un proveedor) para el restaurante. Si quien compra es el CLIENTE del restaurante (le compra al restaurante su comida, sus combos o sus platos), es un domicilio normal.
  "encargo" es false en un domicilio normal, aunque: nombre los productos del pedido ("2 hamburguesas cheese"), diga que el cliente compró algo ("el cliente compró 3 pizzas"), reenvíe o copie el mensaje de un cliente que quiere comprar ("Hola quiero comprar 2 combos para la Cra 85 # 15-40, soy Mario 3014445566", "mi cliente quiere comprar una pizza y que se la lleven a…"), la entrega sea en una tienda, droguería o galería ("domi para el D1 de la 100, el cliente trabaja ahí"), pregunte el precio hasta una tienda, pida llevar datáfono o cambio, o pida que le traigan la plata, el datáfono o la factura (eso es "reclamo" o "notas"). "Necesito un domi" solo, sin decir qué, es false.
- "cancelar": true si el restaurante pide cancelar o anular un pedido que YA se creó o ya se confirmó ("me lo cancelas?", "cancélame el A-57", "cancela el pedido", "anula ese domi", "el cliente canceló, ya no va"). En Colombia "cancelar" también es PAGAR: "el cliente cancela en efectivo", "cancela con billete de 50", "ya canceló por Nequi", "le cancela al domi" son false (eso es el método de pago). Quitar una entrega del pedido que todavía se está armando ("quita la 2", "el de Pance ya no va") va en "quitar", no aquí: false.
- "confuso": true SOLO si el restaurante pide hablar con una persona, está molesto (salvo que sea un "reclamo" de plata o datáfono), o se contradice sin aclarar cuál dato es el bueno. Saludos, reclamos de plata/datáfono, preguntas de precio o de cobertura, mensajes cortos, reenviados o incompletos NO son confusos.
- No agregues texto fuera del JSON.`;
}

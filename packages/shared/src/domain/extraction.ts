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

export type PaymentMethod = "efectivo" | "transferencia";

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
  /** `km` null = el precio lo dio el asesor, sin distancia medida. */
  cotizacion?: { precio: number; km: number | null } | null;
  /** El mapa no la ubicó, pero el asesor dijo que es válida y cuánto vale:
   *  no se vuelve a buscar mientras no cambie la dirección. */
  validadaPorAsesor?: boolean;
};

/** Lo que el bot le preguntó a la central: las entregas (por posición) que
 *  el mapa no ubicó. Mientras espera, el bot no responde en ese chat. */
export type AdvisorQuery = { entregas: number[]; desde: string };

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
  /** El mapa no ubicó una dirección (o no respondió): se le preguntó a la
   *  central si es válida y cuánto vale. Lo responde en el portal. */
  consultaAsesor?: AdvisorQuery | null;
  /** Los nombres ya comparados con los restaurantes (normalizados): cada uno
   *  se compara una sola vez por pedido. */
  nombresRevisados?: string[];
  /** Un número registrado dijo ser otro restaurante y se le preguntó si es
   *  el suyo. Se pregunta una sola vez. */
  preguntaIdentidad?: boolean;
};

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
export type OrderFieldKey = "origenRestaurante" | Exclude<keyof DeliveryFields, "barrio" | "esConjunto" | "dudas">;

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
  /\b(conjunto|conj|unidad(?!\s+(deportiva|m[eé]dica|de\b))|edificio|edif|edf|torres?|bloques?|apto|apartamentos?|condominio|multifamiliar(es)?|residencias)\b/iu;

/** «apto 302», «torre 2», «casa 14», «bloque C»: la puerta ya viene en el texto. */
const UNIT_NUMBER = /\b(apto|apartamento|torre|bloque|casa|interior|int)\b\.?\s*(n[°º.o]?\s*)?#?\s*([a-z]?\d+|[a-z]\b)/iu;

/** La dirección nombra un conjunto, edificio o torre pero no dice a qué
 *  puerta ir. */
export function looksLikeMultiUnit(address: string | null | undefined): boolean {
  return !!address && MULTI_UNIT_WORDS.test(address) && !UNIT_NUMBER.test(address);
}

/** Calle, carrera, avenida…: el tipo de vía, sin el cual «la 42 con 83» puede
 *  ser una calle o una carrera. */
const ROAD_TYPE =
  /\b(calle|cll?|carrera|cra|cr|kra?|kr|avenida|av|avda|diagonal|dg|diag|transversal|tv|trans|transv|autopista|circular|circ|v[ií]a|km|kil[oó]metro|manzana|mz|vereda|corregimiento|sector)\b/iu;

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

/** La dirección tal como la lee el motorizado: calle y, si hay, torre y apto. */
export function fullAddress(delivery: Pick<DeliveryDraft, "direccionEntrega" | "detalleDireccion">): string {
  const { direccionEntrega: street, detalleDireccion: detail } = delivery;
  // El modelo a veces deja la torre o la casa también en la dirección: no se repite.
  const squash = (t: string) => t.toLowerCase().replace(/[^a-z0-9]/g, "");
  if (!detail || (street && squash(street).includes(squash(detail)))) return street ?? "";
  return [street, detail].filter(Boolean).join(" · ");
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
  const moved = !address || !DOOR_ONLY.test(address) || STREET.test(address) ? fields : { ...fields, direccionEntrega: null, detalleDireccion: fields.detalleDireccion ?? address };
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
      "direccionEntrega": string | null,  // calle y número (o el lugar conocido), nombre del conjunto o edificio y barrio; SIN torre ni apto (van en detalleDireccion) y SIN puntos de referencia (van en notas)
      "telefonoCliente": string | null,   // solo dígitos
      "nombreCliente": string | null,
      "valorACobrar": number | null,      // lo que el motorizado le cobra al cliente, en pesos
      "metodoPago": "efectivo" | "transferencia" | null,
      "listoEnMinutos": number | null,    // en cuántos minutos está lista la comida; 0 si ya está lista
      "notas": string | null,             // solo lo NUEVO de este mensaje que el motorizado deba saber
      "detalleDireccion": string | null,  // torre, bloque, apartamento, casa, piso, oficina o local: "Torre 3 apto 502"
      "esConjunto": boolean | null,       // true si la dirección es un conjunto, unidad, edificio, condominio o torres
      "barrio": string | null,            // el barrio del CLIENTE ("Bochalema", "Cañasgordas"), aunque venga dentro de la dirección; no la comuna ni el barrio del restaurante; null si no se sabe
      "dudas": string[]                   // nombres de los campos de ESTA entrega que leíste pero no estás seguro; [] si ninguno
    }
  ],
  "quitar": number[],                   // posiciones (1 = la primera) de las entregas YA CAPTURADAS que el restaurante pide sacar del pedido; [] si ninguna
  "consulta": "estado" | "cobertura" | null,
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
- "quitar": cuando el restaurante dice que sobra una entrega o que ya no va: "quita la 2", "el de Pance ya no va", "cancela el segundo", "solo es 1", "es uno solo", "no son dos". Pon la posición de las que sobran; si dice "solo es 1" sin decir cuál, las que repiten la dirección de otra o no tienen datos del cliente. Aun así devuelve en "entregas" todas las capturadas: el código las quita. [] si no pide quitar ninguna.
- El tiempo de preparación dicho sin señalar una entrega ("en 10", "ya están los 2") aplica a todas las entregas que no lo tengan.
- Preguntar el precio ("¿qué vale a…?", "¿cuánto a…?", "¿domis acá?") es una cotización normal: la dirección o el lugar SIEMPRE va en "entregas", aunque no traiga nada más, y no es confuso. Sin ella no hay con qué cotizar.
  Ejemplo: "¿Cuánto a la Cra 98 # 45-30 Valle del Lili?" → "entregas": [{"direccionEntrega": "Cra 98 # 45-30, Valle del Lili", el resto null}], "intencion": "cotizar", "consulta": null.
- Una línea "(Ubicación de WhatsApp: X)" es un pin que el restaurante mandó en ese punto del mensaje: es la dirección de la entrega de la que habla junto a él ("a esta", "para esta dirección", "aquí"). Usa X tal cual como su "direccionEntrega"; si esa entrega ya tenía una dirección escrita, el pin es su ubicación: deja la escrita.
- Un lugar conocido sirve como dirección de entrega: "Clínica Farallones", "Centro Comercial Aquarela, local 12", "Unicentro". Guárdalo tal cual.
- "Ya está pagado", "pagó por Nequi/transferencia", "pago Bancolombia", "Daviplata", "tarjeta", "crédito o débito", "pagado a través de Rappi" o "total a cobrar $0" = "transferencia" (y "valorACobrar" null: no se le cobra nada al cliente).
- Fotos de facturas o comandas: lee los datos del domicilio (nombre, teléfono, dirección, barrio, pago). Los productos y precios del pedido no van en ningún campo. Los datos del restaurante que imprime la factura (su nombre, dirección, teléfono, NIT) NO son del cliente.
- "listoEnMinutos": "en 10", "listo en 15", "sale en 15 min" = ese número. "Ya está", "ya está listo", "pueden venir", "ya sale" = 0. Si da un rango ("10 a 15 min"), usa el menor. Si da una hora ("lista a las 7:40"), calcula los minutos desde la "Hora actual" que te paso. Si no dice nada del tiempo, null: nunca lo supongas.
- "detalleDireccion": SOLO lo que identifica la puerta (torre, bloque, interior, apartamento, casa, piso, oficina, local, o un código como "C202"); el barrio y las indicaciones ("dejar en portería") nunca van ahí. Copia completos la torre Y el apartamento: "Torre 1 apto 604" → "Torre 1 apto 604", nunca solo "Apto 604".  Si llega después en un mensaje suelto ("torre 2 apto 301", "casa 14"), va a la entrega que no lo tenga. No lo repitas en "direccionEntrega" ni en "notas" (si ya va en "valorACobrar" o "metodoPago", tampoco en notas), pero no quites de "direccionEntrega" nada más: el nombre del conjunto o edificio y el barrio se quedan ahí.
  Ejemplo: "Calle 5 # 66-20, Edificio Torre Alta apto 1203, El Refugio" → direccionEntrega "Calle 5 # 66-20, Edificio Torre Alta, El Refugio", detalleDireccion "Apto 1203", esConjunto true.
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
- "consulta": "estado" si pregunta por un pedido ya pedido ("¿ya llegó?", "¿ya va la moto?", "¿quién va?", "¿dónde va el domicilio?", "¿ya lo recogieron?", "¿cuál es el número del domiciliario?", "pásame el contacto del motorizado"). "cobertura" si pregunta si llegan a algún lugar ("¿domis acá?", "¿llegan a Jamundí?", "¿cubren Pance?"); ese lugar también va en "entregas". En otro caso, null. Preguntar el PRECIO a una dirección no es consulta: es una cotización normal.
- "confuso": true SOLO si el restaurante pide hablar con una persona, está molesto, o se contradice sin aclarar cuál dato es el bueno. Saludos, preguntas de precio o de cobertura, mensajes cortos, reenviados o incompletos NO son confusos.
- No agregues texto fuera del JSON.`;
}

/**
 * Extracción del mensaje libre del restaurante (SPEC §A del prompt maestro).
 *
 * El modelo SOLO extrae; no decide, no calcula, no asigna. Mismo reparto de
 * responsabilidades que ya usaba CLAPI entre el modelo y el código
 * (ver ADR-08/ADR-09 del sistema original): el modelo dice qué nombró el
 * restaurante, el código valida y decide qué falta.
 */

export type PaymentMethod = "efectivo" | "transferencia";

/** Lo que hace falta para despachar: sin esto no sale la moto. */
type RequiredTripFields = {
  origenRestaurante: string | null;
  direccionEntrega: string | null;
  telefonoCliente: string | null;
  valorACobrar: number | null;
  metodoPago: PaymentMethod | null;
  /** Minutos que faltan para que la comida esté lista, contados desde el
   *  mensaje que lo dijo; 0 = ya está lista. El engine lo necesita para no
   *  mandar la moto antes de tiempo. */
  listoEnMinutos: number | null;
};

/** Las zonas viajan en la misma memoria pero NO son obligatorias: si el bot
 *  no reconoce el barrio, el pedido sale igual con la tarifa por defecto. */
type ZoneFields = {
  zonaRecogida?: string | null;
  zonaEntrega?: string | null;
  /** Cuándo se envió el mensaje que dio `listoEnMinutos` (ISO). Lo pone el
   *  código, no el modelo. */
  listoDesde?: string | null;
};

export type ExtractedTripFields = RequiredTripFields & ZoneFields;

/** "Completo": los obligatorios sin `null`, las zonas como vengan. */
export type ResolvedTripFields = { [K in keyof RequiredTripFields]: Exclude<RequiredTripFields[K], null> } & ZoneFields;

export type ExtractionResult =
  | { complete: true; fields: ResolvedTripFields }
  | { complete: false; fields: ExtractedTripFields; missing: (keyof RequiredTripFields)[] };

const REQUIRED_FIELDS: (keyof RequiredTripFields)[] = [
  "origenRestaurante",
  "direccionEntrega",
  "telefonoCliente",
  "valorACobrar",
  "metodoPago",
  "listoEnMinutos",
];

/** Cuántos datos obligatorios tiene un pedido. */
export const REQUIRED_FIELD_COUNT = REQUIRED_FIELDS.length;

/** El modelo devuelve JSON con `null` en lo que no pudo leer; esto decide si
 *  ya alcanza para crear el viaje o hay que repreguntar — y qué. */
export function evaluateExtraction(fields: ExtractedTripFields): ExtractionResult {
  // `== null`: un borrador guardado antes de que existiera un campo no lo trae.
  const missing = REQUIRED_FIELDS.filter((key) => fields[key] == null);
  if (missing.length === 0) {
    return { complete: true, fields: fields as ResolvedTripFields };
  }
  return { complete: false, fields, missing };
}

/** "efectivo requiere retorno a base" (prompt maestro §A): la plata que
 *  cobra el motorizado no es suya, hay que liquidarla — a diferencia de una
 *  transferencia, que ya le llegó directo al restaurante o a la agencia. */
export function requiresCashReturn(metodoPago: PaymentMethod): boolean {
  return metodoPago === "efectivo";
}

export const EMPTY_TRIP_FIELDS: ExtractedTripFields = {
  origenRestaurante: null,
  direccionEntrega: null,
  telefonoCliente: null,
  valorACobrar: null,
  metodoPago: null,
  listoEnMinutos: null,
  zonaRecogida: null,
  zonaEntrega: null,
};

/**
 * La memoria del pedido: lo que ya se sabía más lo que trajo el mensaje
 * nuevo. Un dato nuevo no nulo gana (es una corrección o un dato que
 * faltaba); un `null` nuevo NUNCA borra lo que ya se tenía. Que lo
 * garantice el código y no el modelo: si el modelo "olvida" un campo en su
 * respuesta, el pedido no pierde ese dato.
 */
export function mergeTripFields(known: ExtractedTripFields, incoming: ExtractedTripFields): ExtractedTripFields {
  return {
    origenRestaurante: incoming.origenRestaurante ?? known.origenRestaurante,
    direccionEntrega: incoming.direccionEntrega ?? known.direccionEntrega,
    telefonoCliente: incoming.telefonoCliente ?? known.telefonoCliente,
    valorACobrar: incoming.valorACobrar ?? known.valorACobrar,
    metodoPago: incoming.metodoPago ?? known.metodoPago,
    listoEnMinutos: incoming.listoEnMinutos ?? known.listoEnMinutos ?? null,
    zonaRecogida: incoming.zonaRecogida ?? known.zonaRecogida ?? null,
    zonaEntrega: incoming.zonaEntrega ?? known.zonaEntrega ?? null,
    listoDesde: known.listoDesde ?? null,
  };
}

/** Cuántas veces se repregunta antes de pasar el pedido a una persona. */
export const MAX_CLARIFICATION_ATTEMPTS = 2;

export const ESCALATION_MESSAGE = "Te transferiré con un asesor de la central para gestionar tu pedido.";
export const ASSIGNED_MESSAGE = "Moto asignada. Entre 10 a 15 minutos llega el domiciliario a recoger.";

/**
 * El prompt de extracción. Recibe las zonas de la tabla de tarifas para que
 * el modelo diga a qué barrio pertenece cada dirección ("Cra 119, Caney" →
 * "El Caney"). La zona NO es obligatoria: si no la reconoce, el pedido sale
 * igual con la tarifa por defecto.
 */
export function buildExtractionPrompt(zoneNames: string[]) {
  const zoneList = zoneNames.length ? zoneNames.map((z) => `"${z}"`).join(", ") : "(ninguna)";
  return `Eres el asistente de despacho de una agencia de domicilios en Cali. Un restaurante te escribe por WhatsApp, en texto libre y desordenado, pidiendo una moto. Puede mandar el pedido en varios mensajes.

Recibes los "Datos ya capturados" de mensajes anteriores y el "Mensaje nuevo". Devuelve SOLO este JSON, con el pedido COMPLETO hasta ahora:

{
  "origenRestaurante": string | null,   // dónde se recoge, tal como lo escribió (nombre, dirección y barrio)
  "direccionEntrega": string | null,    // dirección del cliente final
  "telefonoCliente": string | null,     // teléfono del cliente final, solo dígitos
  "valorACobrar": number | null,        // pesos colombianos, solo el número
  "metodoPago": "efectivo" | "transferencia" | null,
  "listoEnMinutos": number | null,      // en cuántos minutos está lista la comida; 0 si ya está lista
  "zonaRecogida": string | null,        // una de las zonas de la lista, o null
  "zonaEntrega": string | null,         // una de las zonas de la lista, o null
  "confuso": boolean
}

Zonas de la agencia: ${zoneList}

Reglas:
- Conserva los datos ya capturados. Solo cámbialos si el mensaje nuevo los corrige explícitamente.
- Si el mensaje nuevo trae solo un dato suelto (por ejemplo, solo un número de teléfono o solo "efectivo"), asígnalo al campo que falta.
- "Ya está pagado", "pagó por Nequi/transferencia" o similar = "transferencia".
- "listoEnMinutos": "listo en 15", "sale en 15 min", "en un cuarto de hora" = 15. "Ya está lista", "ya sale", "lista para recoger" = 0. Si da un rango ("10 a 15 min"), usa el menor. Si da una hora ("lista a las 7:40"), calcula los minutos desde la "Hora actual" que te paso. Si no dice nada del tiempo, null: nunca lo supongas.
- Para las zonas, mira el barrio mencionado en cada dirección y escoge la zona de la lista que corresponda, aunque esté escrita distinto ("caney" → "El Caney", "valle del lili" → "Valle del Lili"). Si no hay barrio o no está en la lista, null. Nunca inventes una zona que no esté en la lista.
- Nunca inventes un valor: lo que no sepas va en null.
- "confuso": true si el restaurante se contradice sin aclarar cuál dato es el bueno, pide algo que no es un domicilio, está molesto o pide hablar con una persona. En cualquier otro caso, false.
- No agregues texto fuera del JSON.`;
}

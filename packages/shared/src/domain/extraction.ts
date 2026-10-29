/**
 * Interpretación del mensaje libre del restaurante y la memoria del pedido.
 *
 * El modelo SOLO interpreta; no decide, no calcula, no asigna. Mismo reparto
 * de responsabilidades que ya usaba CLAPI entre el modelo y el código
 * (ver ADR-08/ADR-09 del sistema original): el modelo dice qué escribió el
 * restaurante, el código valida, cotiza y decide qué sigue.
 */

export type PaymentMethod = "efectivo" | "transferencia";

/** Los datos del pedido que puede traer un mensaje. Las claves en español son
 *  las que devuelve el modelo y las que muestra el portal. */
type OrderFields = {
  /** Dónde se recoge. Solo se pide a un restaurante sin registrar: al
   *  registrado se le conoce por su número. */
  origenRestaurante: string | null;
  direccionEntrega: string | null;
  telefonoCliente: string | null;
  nombreCliente?: string | null;
  valorACobrar: number | null;
  metodoPago: PaymentMethod | null;
  /** Minutos que faltan para que la comida esté lista, contados desde el
   *  mensaje que lo dijo; 0 = ya está lista. */
  listoEnMinutos: number | null;
  /** Lo que no es un campo pero el motorizado necesita saber: "billete de
   *  100 mil", "torre A apto 705", "2 hamburguesas". */
  notas?: string | null;
};

/** En qué va el pedido: `cotizado` = ya se le mandó el precio y se espera la
 *  confirmación; `confirmado` = confirmó y se espera lo que falte. */
export type OrderStage = "recibiendo" | "cotizado" | "confirmado";

/** Lo que pone el código, no el modelo. */
type OrderState = {
  etapa?: OrderStage;
  zonaRecogida?: string | null;
  zonaEntrega?: string | null;
  /** Cuándo se envió el mensaje que dio `listoEnMinutos` (ISO). */
  listoDesde?: string | null;
  /** Coordenadas de la entrega: geocodificadas una vez o del pin de WhatsApp. */
  ubicacionEntrega?: { lat: number; lng: number } | null;
  /** La dirección que se geocodificó; si cambia, se vuelve a ubicar y cotizar. */
  direccionUbicada?: string | null;
  cotizacion?: { precio: number; km: number | null } | null;
  /** El mensaje del restaurante que abrió el pedido: los avisos le responden
   *  citándolo, para que sepa de qué pedido se habla. */
  mensajeOrigen?: string | null;
  /** Un cambio para un pedido ya creado (por ejemplo «ya está listo») cuando
   *  hay varios abiertos y se preguntó a cuál se refiere. */
  actualizacionPendiente?: TripUpdate | null;
};

/** Lo que un mensaje puede cambiar de un pedido ya creado. */
export type TripUpdate = Partial<Pick<OrderFields, "listoEnMinutos" | "notas" | "telefonoCliente" | "nombreCliente" | "valorACobrar" | "metodoPago">> & {
  /** Cuándo se dijo el tiempo (ISO), para contar desde ahí. */
  desde: string;
};

export type ExtractedTripFields = OrderFields & OrderState;
export type OrderDraft = ExtractedTripFields;

export type OrderFieldKey = Exclude<keyof OrderFields, never>;

/** Los obligatorios del primer cliente. Cada agencia puede cambiarlos en
 *  `settings.bot_config` sin tocar el flujo. */
export const DEFAULT_REQUIRED_FIELDS: OrderFieldKey[] = ["direccionEntrega", "listoEnMinutos"];

/** Lo que falta para crear el viaje. `origenRestaurante` se exige solo si el
 *  restaurante no está registrado. */
export function missingFields(draft: OrderDraft, required: OrderFieldKey[], knownRestaurant: boolean): OrderFieldKey[] {
  const keys = knownRestaurant ? required.filter((k) => k !== "origenRestaurante") : ["origenRestaurante" as const, ...required];
  // `== null`: un borrador guardado antes de que existiera un campo no lo trae.
  return [...new Set(keys)].filter((key) => draft[key] == null);
}

/** "efectivo requiere retorno a base" (prompt maestro §A): la plata que
 *  cobra el motorizado no es suya, hay que liquidarla — a diferencia de una
 *  transferencia, que ya le llegó directo al restaurante o a la agencia. */
export function requiresCashReturn(metodoPago: PaymentMethod | null): boolean {
  return metodoPago === "efectivo";
}

export const EMPTY_TRIP_FIELDS: OrderDraft = {
  origenRestaurante: null,
  direccionEntrega: null,
  telefonoCliente: null,
  nombreCliente: null,
  valorACobrar: null,
  metodoPago: null,
  listoEnMinutos: null,
  notas: null,
  etapa: "recibiendo",
  zonaRecogida: null,
  zonaEntrega: null,
};

const FIELD_KEYS: OrderFieldKey[] = [
  "origenRestaurante",
  "direccionEntrega",
  "telefonoCliente",
  "nombreCliente",
  "valorACobrar",
  "metodoPago",
  "listoEnMinutos",
  "notas",
];

/** Cuántos datos del pedido trae un borrador: sirve para saber si un mensaje
 *  aportó algo nuevo. */
export function countFields(draft: OrderDraft): number {
  return FIELD_KEYS.filter((k) => draft[k] != null).length;
}

/**
 * La memoria del pedido: lo que ya se sabía más lo que trajo el mensaje
 * nuevo. Un dato nuevo no nulo gana (es una corrección o un dato que
 * faltaba); un `null` nuevo NUNCA borra lo que ya se tenía. Que lo
 * garantice el código y no el modelo: si el modelo "olvida" un campo en su
 * respuesta, el pedido no pierde ese dato. Las notas se suman, no se pisan.
 */
export function mergeTripFields(known: OrderDraft, incoming: Partial<OrderDraft>): OrderDraft {
  const merged: OrderDraft = { ...known };
  for (const key of FIELD_KEYS) {
    if (key === "notas") continue;
    const value = incoming[key];
    if (value != null) (merged as Record<string, unknown>)[key] = value;
  }
  const notes = [known.notas, incoming.notas].filter((n): n is string => !!n?.trim());
  merged.notas = notes.length ? [...new Set(notes)].join(" · ") : null;
  return merged;
}

/** Cuántas veces se repregunta antes de pasar el pedido a una persona. */
export const MAX_CLARIFICATION_ATTEMPTS = 2;

export const ESCALATION_MESSAGE = "Te transferiré con un asesor de la central para gestionar tu pedido.";
export const ASSIGNED_MESSAGE = "Moto asignada. Entre 10 a 15 minutos llega el domiciliario a recoger.";

/**
 * El prompt de interpretación. Recibe las zonas de la tabla de tarifas para
 * que el modelo diga a qué barrio pertenece cada dirección. La zona NO es
 * obligatoria: si no la reconoce, se cobra por distancia o con la tarifa por
 * defecto.
 */
export function buildExtractionPrompt(zoneNames: string[]) {
  const zoneList = zoneNames.length ? zoneNames.map((z) => `"${z}"`).join(", ") : "(ninguna)";
  return `Eres el asistente de despacho de una agencia de domicilios en Cali. Un restaurante te escribe por WhatsApp, en texto libre y desordenado, para cotizar o pedir una moto. Puede mandar el pedido en varios mensajes, reenviar mensajes de su cliente o escribir muy corto ("en 10", "ya está").

Recibes los "Datos ya capturados" del pedido en curso (incluida la "etapa": "recibiendo", "cotizado" si ya se le mandó el precio, "confirmado" si ya confirmó) y el "Mensaje nuevo". Devuelve SOLO este JSON, con el pedido COMPLETO hasta ahora:

{
  "origenRestaurante": string | null,   // dónde se recoge, si lo dice (nombre, dirección y barrio)
  "direccionEntrega": string | null,    // dirección del cliente final, completa (con conjunto, torre, apto si los da)
  "telefonoCliente": string | null,     // teléfono del cliente final, solo dígitos
  "nombreCliente": string | null,
  "valorACobrar": number | null,        // lo que el motorizado le cobra al cliente, en pesos
  "metodoPago": "efectivo" | "transferencia" | null,
  "listoEnMinutos": number | null,      // en cuántos minutos está lista la comida; 0 si ya está lista
  "notas": string | null,               // solo lo NUEVO de este mensaje que el motorizado deba saber
  "zonaRecogida": string | null,        // una de las zonas de la lista, o null
  "zonaEntrega": string | null,         // una de las zonas de la lista, o null
  "confirma": boolean,
  "confuso": boolean
}

Zonas de la agencia: ${zoneList}

Reglas:
- Preguntar el precio ("¿qué vale a…?", "¿cuánto a…?", "¿domis acá?") es una cotización normal: extrae la dirección o el lugar y no es confuso.
- Un lugar conocido sirve como dirección de entrega: "Clínica Farallones", "Centro Comercial Aquarela, local 12", "Unicentro". Guárdalo tal cual en "direccionEntrega".
- Conserva los datos ya capturados. Solo cámbialos si el mensaje nuevo los corrige explícitamente.
- Si el mensaje nuevo trae solo un dato suelto (por ejemplo, solo un número de teléfono), asígnalo al campo que corresponda.
- "Ya está pagado", "pagó por Nequi/transferencia" o similar = "transferencia".
- "listoEnMinutos": "en 10", "listo en 15", "sale en 15 min" = ese número. "Ya está", "ya está listo", "pueden venir", "ya sale" = 0. Si da un rango ("10 a 15 min"), usa el menor. Si da una hora ("lista a las 7:40"), calcula los minutos desde la "Hora actual" que te paso. Si no dice nada del tiempo, null: nunca lo supongas.
- "notas": instrucciones de entrega, con cuánto paga el cliente ("billete de 100 mil"), qué lleva el pedido, horarios o referencias del lugar. No repitas lo que ya va en otro campo ni lo que ya estaba en las notas.
- "confirma": true solo si la etapa es "cotizado" o "confirmado" y el restaurante acepta el servicio: "sí", "dale", "listo", "confirmo", o da el tiempo de preparación. En la etapa "recibiendo", siempre false.
- Para las zonas, mira el barrio mencionado en cada dirección y escoge la zona de la lista que corresponda, aunque esté escrita distinto. Si no hay barrio o no está en la lista, null. Nunca inventes una zona.
- Nunca inventes un valor: lo que no sepas va en null.
- "confuso": true SOLO si el restaurante pide hablar con una persona, está molesto, o se contradice sin aclarar cuál dato es el bueno. Saludos, preguntas de precio o de cobertura, mensajes cortos, reenviados o incompletos NO son confusos.
- No agregues texto fuera del JSON.`;
}

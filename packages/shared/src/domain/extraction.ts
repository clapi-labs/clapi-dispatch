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
   *  100 mil", "torre A apto 705", "2 hamburguesas". */
  notas: string | null;
  zonaEntrega?: string | null;
};

/** Una entrega del pedido: lo que dijo el restaurante y lo que calculó el código. */
export type DeliveryDraft = DeliveryFields & {
  /** Cuándo se envió el mensaje que dio `listoEnMinutos` (ISO). */
  listoDesde?: string | null;
  /** Coordenadas de la entrega: geocodificadas una vez o del pin de WhatsApp. */
  ubicacionEntrega?: { lat: number; lng: number } | null;
  /** La dirección que se geocodificó; si cambia, se vuelve a ubicar y cotizar. */
  direccionUbicada?: string | null;
  cotizacion?: { precio: number; km: number | null } | null;
};

/** En qué va el pedido: `cotizado` = ya se le mandó el precio y se espera la
 *  confirmación; `confirmado` = confirmó y se espera lo que falte. */
export type OrderStage = "recibiendo" | "cotizado" | "confirmado";

/** Lo que un mensaje puede cambiar de un pedido ya creado. */
export type TripUpdate = Partial<Pick<DeliveryFields, "listoEnMinutos" | "notas" | "telefonoCliente" | "nombreCliente" | "valorACobrar" | "metodoPago">> & {
  /** Cuándo se dijo el tiempo (ISO), para contar desde ahí. */
  desde: string;
};

/** El pedido a medio armar de una conversación (`conversations.draft`). */
export type OrderDraft = {
  etapa: OrderStage;
  /** Dónde se recoge. Solo se pide a un restaurante sin registrar: al
   *  registrado se le conoce por su número. */
  origenRestaurante: string | null;
  zonaRecogida?: string | null;
  entregas: DeliveryDraft[];
  /** El mensaje del restaurante que abrió el pedido: los avisos le responden
   *  citándolo, para que sepa de qué pedido se habla. */
  mensajeOrigen?: string | null;
  /** Un cambio para un pedido ya creado (por ejemplo «ya está listo») cuando
   *  hay varios abiertos y se preguntó a cuál se refiere. */
  actualizacionPendiente?: TripUpdate | null;
};

/** Lo que devuelve el modelo por mensaje. */
export type Interpretation = {
  origenRestaurante: string | null;
  zonaRecogida: string | null;
  entregas: DeliveryFields[];
};

/** Lo que se puede exigir por agencia antes de crear el viaje. */
export type OrderFieldKey = "origenRestaurante" | Exclude<keyof DeliveryFields, "zonaEntrega">;

/** Los obligatorios del primer cliente. Cada agencia puede cambiarlos en
 *  `settings.bot_config` sin tocar el flujo. */
export const DEFAULT_REQUIRED_FIELDS: OrderFieldKey[] = ["direccionEntrega", "listoEnMinutos"];

const DELIVERY_KEYS = ["direccionEntrega", "telefonoCliente", "nombreCliente", "valorACobrar", "metodoPago", "listoEnMinutos", "notas"] as const;

export function emptyDelivery(): DeliveryDraft {
  return {
    direccionEntrega: null,
    telefonoCliente: null,
    nombreCliente: null,
    valorACobrar: null,
    metodoPago: null,
    listoEnMinutos: null,
    notas: null,
    zonaEntrega: null,
  };
}

export function emptyDraft(): OrderDraft {
  return { etapa: "recibiendo", origenRestaurante: null, zonaRecogida: null, entregas: [] };
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
    zonaRecogida: (r.zonaRecogida as string) ?? null,
    mensajeOrigen: (r.mensajeOrigen as string) ?? null,
    actualizacionPendiente: (r.actualizacionPendiente as TripUpdate) ?? null,
    entregas: hasDelivery ? [legacy] : [],
  };
}

/** Lo que le falta a una entrega para crear su viaje. `origenRestaurante`
 *  es del pedido, no de la entrega: se revisa aparte. */
export function missingFields(delivery: DeliveryDraft, required: OrderFieldKey[]): Exclude<OrderFieldKey, "origenRestaurante">[] {
  return required.filter((k): k is Exclude<OrderFieldKey, "origenRestaurante"> => k !== "origenRestaurante" && delivery[k] == null);
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
  for (const key of DELIVERY_KEYS) {
    if (key === "notas") continue;
    const value = incoming[key];
    if (value != null) (merged as Record<string, unknown>)[key] = value;
  }
  if (incoming.zonaEntrega) merged.zonaEntrega = incoming.zonaEntrega;
  const notes = [known.notas, incoming.notas].filter((n): n is string => !!n?.trim());
  merged.notas = notes.length ? [...new Set(notes)].join(" · ") : null;
  return merged;
}

/**
 * La memoria del pedido: lo que ya se sabía más lo que trajo el mensaje
 * nuevo. El modelo devuelve la lista completa de entregas hasta ahora, en el
 * mismo orden: la entrega N del mensaje se junta con la N que ya había, y
 * una de más es una entrega nueva. Un dato nuevo no nulo gana (es una
 * corrección o un dato que faltaba); un `null` nuevo NUNCA borra lo que ya se
 * tenía, y una entrega que el modelo "olvide" tampoco se pierde. Que lo
 * garantice el código y no el modelo.
 */
export function mergeTripFields(known: OrderDraft, incoming: Interpretation): OrderDraft {
  const count = Math.max(known.entregas.length, incoming.entregas.length);
  const entregas: DeliveryDraft[] = [];
  for (let i = 0; i < count; i++) {
    const base = known.entregas[i] ?? emptyDelivery();
    entregas.push(incoming.entregas[i] ? mergeDelivery(base, incoming.entregas[i]) : base);
  }
  return {
    ...known,
    origenRestaurante: incoming.origenRestaurante ?? known.origenRestaurante,
    zonaRecogida: incoming.zonaRecogida ?? known.zonaRecogida ?? null,
    entregas,
  };
}

/** Cuántas veces se repregunta antes de pasar el pedido a una persona. */
export const MAX_CLARIFICATION_ATTEMPTS = 2;

export const ESCALATION_MESSAGE = "Te transferiré con un asesor de la central para gestionar tu pedido.";

/**
 * El prompt de interpretación. Recibe las zonas de la tabla de tarifas para
 * que el modelo diga a qué barrio pertenece cada dirección. La zona NO es
 * obligatoria: si no la reconoce, se cobra por distancia o con la tarifa por
 * defecto.
 */
export function buildExtractionPrompt(zoneNames: string[]) {
  const zoneList = zoneNames.length ? zoneNames.map((z) => `"${z}"`).join(", ") : "(ninguna)";
  return `Eres el asistente de despacho de una agencia de domicilios en Cali. Un restaurante te escribe por WhatsApp, en texto libre y desordenado, para cotizar o pedir motos. Puede mandar el pedido en varios mensajes, reenviar mensajes de su cliente, escribir muy corto ("en 10", "ya está") o pedir varios domicilios a la vez.

Recibes los "Datos ya capturados" del pedido en curso (con su "etapa": "recibiendo", "cotizado" si ya se le mandó el precio, "confirmado" si ya confirmó) y el "Mensaje nuevo". Devuelve SOLO este JSON, con el pedido COMPLETO hasta ahora:

{
  "origenRestaurante": string | null,   // dónde se recoge, si lo dice (nombre, dirección y barrio)
  "zonaRecogida": string | null,        // una de las zonas de la lista, o null
  "entregas": [                         // una por cada cliente final, en el mismo orden de los datos ya capturados
    {
      "direccionEntrega": string | null,  // completa, tal como la escribió: con barrio, conjunto, torre y apto si los da
      "telefonoCliente": string | null,   // solo dígitos
      "nombreCliente": string | null,
      "valorACobrar": number | null,      // lo que el motorizado le cobra al cliente, en pesos
      "metodoPago": "efectivo" | "transferencia" | null,
      "listoEnMinutos": number | null,    // en cuántos minutos está lista la comida; 0 si ya está lista
      "notas": string | null,             // solo lo NUEVO de este mensaje que el motorizado deba saber
      "zonaEntrega": string | null        // una de las zonas de la lista, o null
    }
  ],
  "confirma": boolean,
  "confuso": boolean
}

Zonas de la agencia: ${zoneList}

Reglas:
- Cada cliente final con su propia dirección es una entrega aparte. Dos direcciones = dos entregas, aunque lleguen en el mismo mensaje.
- Conserva las entregas ya capturadas, en su orden. NUNCA devuelvas menos entregas de las capturadas.
- Una dirección nueva que el restaurante presenta como OTRO pedido ("y otro para…", "también a…", datos de un segundo cliente) se agrega al final.
- Una CORRECCIÓN ("perdón, era…", "me equivoqué…", "la dirección correcta es…", "el de Pance es…", "no, es la…") NO agrega una entrega: reemplaza la dirección de la entrega que corrige, y la lista queda del mismo tamaño. Si no dice cuál corrige y hay varias, corrige la última.
  Ejemplo: capturadas [El Caney, Pance]; mensaje "perdón, el de Pance es Cra 105 # 14-30, Ciudad Jardín" → [El Caney, Cra 105 # 14-30, Ciudad Jardín].
- Un dato suelto (solo un teléfono, solo un nombre) va a la entrega que le falte; si todas lo tienen o no se sabe, a la última.
- El tiempo de preparación dicho sin señalar una entrega ("en 10", "ya están los 2") aplica a todas las entregas que no lo tengan.
- Preguntar el precio ("¿qué vale a…?", "¿cuánto a…?", "¿domis acá?") es una cotización normal: extrae la dirección o el lugar y no es confuso.
- Un lugar conocido sirve como dirección de entrega: "Clínica Farallones", "Centro Comercial Aquarela, local 12", "Unicentro". Guárdalo tal cual.
- "Ya está pagado", "pagó por Nequi/transferencia" o similar = "transferencia".
- "listoEnMinutos": "en 10", "listo en 15", "sale en 15 min" = ese número. "Ya está", "ya está listo", "pueden venir", "ya sale" = 0. Si da un rango ("10 a 15 min"), usa el menor. Si da una hora ("lista a las 7:40"), calcula los minutos desde la "Hora actual" que te paso. Si no dice nada del tiempo, null: nunca lo supongas.
- "notas": instrucciones de entrega, con cuánto paga el cliente ("billete de 100 mil"), qué lleva el pedido, horarios o referencias del lugar. No repitas lo que ya va en otro campo ni lo que ya estaba en las notas.
- "confirma": true solo si la etapa es "cotizado" o "confirmado" y el restaurante acepta el servicio: "sí", "dale", "listo", "confirmo", "ya están los 2", o da el tiempo de preparación. En la etapa "recibiendo", siempre false.
- Para las zonas, mira el barrio de cada dirección y escoge la zona de la lista que corresponda, aunque esté escrita distinto. Si no hay barrio o no está en la lista, null. Nunca inventes una zona.
- Nunca inventes un valor: lo que no sepas va en null.
- Si no hay entregas capturadas y el mensaje trae datos sueltos sin dirección ("ya está listo", "en 10", "paga con 50 mil", un teléfono), devuélvelos en UNA entrega con "direccionEntrega": null. "entregas" va vacío solo si el mensaje no trae ningún dato (un saludo, por ejemplo).
- "confuso": true SOLO si el restaurante pide hablar con una persona, está molesto, o se contradice sin aclarar cuál dato es el bueno. Saludos, preguntas de precio o de cobertura, mensajes cortos, reenviados o incompletos NO son confusos.
- No agregues texto fuera del JSON.`;
}

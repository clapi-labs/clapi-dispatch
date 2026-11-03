/**
 * Variables de entorno del bot. Mismo patrón que CLAPI
 * (`demo-delivery-system/apps/bot/src/env.ts`): se validan al leerlas, no al
 * importar — en serverless no hay un "arranque" donde fallar, y Next evalúa
 * módulos durante el build sin tener los secretos a mano.
 */

function required(key: string): string {
  const value = process.env[key];
  if (!value) {
    throw new Error(`Falta la variable de entorno ${key}. Ver .env.example.`);
  }
  return value;
}

function optional(key: string, fallback = ""): string {
  return process.env[key] ?? fallback;
}

export const env = {
  // Las mismas 4 credenciales que usa demo-delivery-system/apps/bot — es el
  // mismo número de WhatsApp mientras se prueba esto (ver docs/DEPLOYMENT
  // pendiente). PHONE_NUMBER_ID y ACCESS_TOKEN desde el panel de Meta;
  // VERIFY_TOKEN es una cadena propia, idéntica acá y en el panel;
  // APP_SECRET firma cada webhook.
  whatsapp: {
    get phoneNumberId() {
      return required("WHATSAPP_PHONE_NUMBER_ID");
    },
    get accessToken() {
      return required("WHATSAPP_ACCESS_TOKEN");
    },
    get verifyToken() {
      return required("WHATSAPP_VERIFY_TOKEN");
    },
    get appSecret() {
      return required("WHATSAPP_APP_SECRET");
    },
    get apiVersion() {
      return optional("WHATSAPP_API_VERSION", "v21.0");
    },
  },

  openai: {
    get apiKey() {
      return required("OPENAI_API_KEY");
    },
    get chatModel() {
      return optional("OPENAI_CHAT_MODEL", "gpt-4o-mini");
    },
  },

  /** Opcional: sin la llave, los viajes se crean sin coordenadas y los asigna
   *  la cola actual. Con ella, la dirección de entrega se exige ubicada. */
  google: {
    get mapsApiKey() {
      return optional("GOOGLE_MAPS_API_KEY");
    },
  },

  /**
   * El número se comparte con el sistema de pedidos de restaurante
   * (`demo-delivery-system`) mientras se prueba esto — nunca los dos activos
   * a la vez. Por defecto apagado: hay que prenderlo a propósito.
   */
  get botActive() {
    return optional("BOT_ACTIVE", "false") === "true";
  },

  /** Pruebas locales: los envíos se imprimen en vez de ir a Meta. */
  get whatsappSimulated() {
    return optional("WHATSAPP_SIMULADO", "false") === "true";
  },
  /** Ubicaciones inventadas en vez de Google: solo pruebas y demostraciones. */
  get geocodeSimulated() {
    return optional("GEOCODE_SIMULADO", "false") === "true";
  },

  get internalSecret() {
    return required("INTERNAL_SECRET");
  },
};

export function assertEnv(): { ok: boolean; missing: string[] } {
  const missing = [
    "DATABASE_URL",
    "WHATSAPP_PHONE_NUMBER_ID",
    "WHATSAPP_ACCESS_TOKEN",
    "WHATSAPP_VERIFY_TOKEN",
    "WHATSAPP_APP_SECRET",
    "OPENAI_API_KEY",
    "INTERNAL_SECRET",
  ].filter((key) => !process.env[key]);

  return { ok: missing.length === 0, missing };
}

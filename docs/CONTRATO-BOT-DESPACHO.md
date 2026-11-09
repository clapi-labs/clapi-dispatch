# Contrato entre el bot y el despacho

Cómo se reparten el trabajo el **bot** (la conversación por WhatsApp) y el **despacho** (quién se asigna a cada pedido, hoy la cola y luego el engine). Sirve para que cada lado avance sin esperar al otro: el bot se construye contra este contrato y el despacho lo cumple, primero con la cola actual y después con el engine, sin que el bot cambie.

El contrato del engine en sí (`POST /evaluar`) está en [`ALGORITMO.md`](ALGORITMO.md). Este documento está una capa más arriba: es lo que el bot ve.

## Quién hace qué

| | Bot | Despacho |
|---|---|---|
| Habla con restaurantes y motorizados | Sí | No |
| Entiende los mensajes (texto e imagen) | Sí | No |
| Geocodifica direcciones | Sí, una vez por dirección | No |
| Cotiza el domicilio | Sí, con `quoteByDistance` | No |
| Crea el viaje en la base (`pending`) | Sí | No |
| Elige la moto y guarda la asignación | No | Sí, con `despachar` |
| Envía avisos de asignación y entrega | Sí, a partir del resultado | No |

La base de datos es el único estado compartido. El despacho nunca escribe por WhatsApp y el bot nunca decide qué moto va.

## 1. `despachar(tripId)`

Se llama cada vez que algo puede cambiar quién va a un pedido:

- el bot acaba de crear el viaje;
- una moto entregó, se conectó o quedó libre;
- el tick del worker (para los pedidos en espera).

```ts
function despachar(tripId: number): Promise<ResultadoDespacho>;

type ResultadoDespacho =
  | {
      tipo: "asignado";
      tripId: number;
      courier: { id: number; nombre: string; telefono: string };
      llegaEnMin: number | null;   // al restaurante; null si no se sabe
    }
  | {
      tipo: "en_espera";
      tripId: number;
      despacharA: Date | null;     // cuándo se va a asignar; null si no se sabe
    }
  | {
      tipo: "sin_motos";
      tripId: number;              // nadie elegible ahora; se reintenta solo
    };
```

Reglas:

- **Idempotente y segura en paralelo.** Llamarla dos veces, o desde dos lugares a la vez, nunca asigna el mismo viaje dos veces. Si el viaje ya estaba asignado, devuelve `asignado` con la misma moto.
- **No envía mensajes.** Solo decide y guarda. El bot arma los avisos con el resultado.
- **Si el engine falla**, no inventa una asignación: devuelve `sin_motos`, el viaje sigue `pending`, se reintenta en el siguiente tick y se deja el error en los logs para alertar.

| Implementación | `asignado` | `en_espera` | `sin_motos` |
|---|---|---|---|
| **Hoy: la cola** (`dispatch-queue.ts`) | Primera moto libre, `llegaEnMin: null` | Nunca | Todas ocupadas |
| **Luego: el engine** | `ganador` con `faltan_min = 0`, `llegaEnMin = t_a_min` | `faltan_min > 0`, `despacharA = despachar_ts` | `ganador = null` o engine caído |

Para el tick hay una variante que recorre todos los pendientes y devuelve un resultado por cada uno:

```ts
function despacharPendientes(): Promise<ResultadoDespacho[]>;
```

## 2. `quoteByDistance(origen, destino)`

El precio del domicilio por distancia. La usa el bot al cotizar y al crear el viaje (el precio se congela en `trips.delivery_fee`). Vive en `packages/shared/src/db/quote.ts`.

```ts
function quoteByDistance(from: GeoPoint, to: GeoPoint): Promise<Quote>;

type GeoPoint = { lat: number; lng: number };
type Quote = { km: number; price: number | null };
```

- `km` es la distancia en línea recta (Haversine) por el factor de ruta (1,3, el mismo `FACTOR_RUTA` del engine). Gratis, sin red.
- `price` sale de la tabla de rangos por kilómetro que se edita en el portal (`settings.fare_ranges`), y nunca es menor que el mínimo de la zona de entrega (`price_zones`, ver [DIRECCIONES-Y-ZONAS.md](DIRECCIONES-Y-ZONAS.md), «Precio mínimo por zona»). La respuesta también trae `kmPrice` (solo la tabla) y `zone` (la zona que mandó, o `null`). Si la tabla está vacía, `price` es `null`: no hay tarifa por defecto, y el bot pasa el pedido a la central.
- Si más adelante el engine ofrece una distancia mejor, cambia el interior de la función, no su forma.

## 3. Lo que el bot deja en la base para el engine

El engine no guarda nada: todo lo que necesita lo lee el despacho de la base. El bot se compromete a dejarlo:

| Dato | Dónde | Cuándo |
|---|---|---|
| Ubicación del restaurante | `restaurants.known_pickup_location` | Una vez, al registrar el restaurante |
| Ubicación de la entrega | `trips.delivery_location` | Al crear el viaje |
| Hora en que la comida está lista | `trips.ready_at` | Al crear el viaje |
| Recogido | `assignments.picked_up_at` | Cuando el motorizado toca «Recogí» |
| Entregado | `assignments.delivered_at` y `delivery_place` | Cuando el motorizado marca la entrega |
| De regreso | `assignments.return_started_at` | Cuando marca la entrega con «vuelvo» |
| Terminado | `assignments.finished_at` | Al marcar la entrega con «terminé» o al tocar «Ya volví» |
| Conexión del motorizado | `couriers.status` y la hora | Cuando escribe para conectarse |

El despacho se encarga del resto: la `cuota`, el `plan` de cada asignación y `disponible_desde_ts`.

## 4. Lo que no cambia al conectar el engine

Si el contrato se respeta, conectar el engine solo toca el interior de `despachar` (y, si se quiere, el de `quoteByDistance`). No cambian:

- los mensajes al restaurante y al motorizado;
- el flujo de la conversación;
- las rutas `/api/internal/*`.

## En el código

El contrato se escribió antes de construir; los nombres reales son estos:

| En este documento | En el código |
|---|---|
| `despachar(tripId)` al crear el viaje | `dispatchNewTrip` (`apps/bot/src/dispatch/engine.ts`): en `auto` lo despacha el engine si ya es hora; si no, la cola le da la próxima moto libre (`assignNextCourier`). Devuelve si quedó asignado |
| `despacharPendientes()` en el tick | `/api/internal/tick` corre `assignPendingTrips` (la cola, que no hace nada en `auto`) y `runEngine` (el engine, que solo asigna en `auto`) |
| Asignar a mano desde el portal | `assignTripTo`; quitarle un pedido sin recoger a una moto, `returnTripToDispatch` (`packages/shared/src/db/dispatch-queue.ts`) |
| `en_espera` / `sin_motos` | El viaje sigue `pending`; el motivo y la hora prevista quedan en `engine_evaluations` y el tablero los muestra |
| `quoteByDistance` | Igual (`packages/shared/src/db/quote.ts`) |

Los avisos los arma el bot con el resultado (`notifyAssigned` en `apps/bot/src/bot/notify.ts`), como dice el contrato.

## Cambios a este contrato

Cualquier cambio a estas firmas se acuerda entre los dos lados y se actualiza aquí antes de implementarlo.

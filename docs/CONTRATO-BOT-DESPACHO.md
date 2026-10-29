# Contrato entre el bot y el despacho

Cómo se reparten el trabajo el **bot** (la conversación por WhatsApp) y el **despacho** (quién se asigna a cada pedido, hoy la cola y luego el engine). Sirve para que cada lado avance sin esperar al otro: el bot se construye contra este contrato y el despacho lo cumple, primero con la cola actual y después con el engine, sin que el bot cambie.

El contrato del engine en sí (`POST /evaluar`) está en [`ALGORITMO.md`](ALGORITMO.md). Este documento está una capa más arriba: es lo que el bot ve.

## Quién hace qué

| | Bot | Despacho |
|---|---|---|
| Habla con restaurantes y motorizados | Sí | No |
| Entiende los mensajes (texto e imagen) | Sí | No |
| Geocodifica direcciones | Sí, una vez por dirección | No |
| Cotiza el domicilio | Sí, con `cotizar` | No |
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

## 2. `cotizar(origen, destino)`

El precio del domicilio por distancia. La usa el bot al cotizar y al crear el viaje (el precio se congela en `trips.delivery_fee`).

```ts
function cotizar(origen: LatLng, destino: LatLng): Promise<Cotizacion>;

type LatLng = { lat: number; lng: number };
type Cotizacion = { km: number; precio: number };
```

- `km` es la distancia en línea recta (Haversine) por un factor de ruta (1,3, el mismo del engine). Gratis, sin red.
- `precio` sale de la tabla de rangos por kilómetro que se edita en el portal (`settings.fare_ranges`).
- Si más adelante el engine ofrece una distancia mejor, cambia el interior de `cotizar`, no su forma.

## 3. Lo que el bot deja en la base para el engine

El engine no guarda nada: todo lo que necesita lo lee el despacho de la base. El bot se compromete a dejarlo:

| Dato | Dónde | Cuándo |
|---|---|---|
| Ubicación del restaurante | `restaurants.known_pickup_location` | Una vez, al registrar el restaurante |
| Ubicación de la entrega | `trips.delivery_location` | Al crear el viaje |
| Hora en que la comida está lista | `trips.ready_at` | Al crear el viaje |
| Recogido | Estado del viaje | Cuando el motorizado toca «Recogido» |
| Entregado | `assignments.delivered_at` | Cuando el motorizado toca «Entregado» |
| Conexión del motorizado | `couriers.status` y la hora | Cuando escribe para conectarse |

El despacho se encarga del resto: la `cuota`, el `plan` de cada asignación y `disponible_desde_ts`.

## 4. Lo que no cambia al conectar el engine

Si el contrato se respeta, conectar el engine solo toca el interior de `despachar` (y, si se quiere, el de `cotizar`). No cambian:

- los mensajes al restaurante y al motorizado;
- el flujo de la conversación;
- las rutas `/api/internal/*`.

## Cambios a este contrato

Cualquier cambio a estas firmas se acuerda entre los dos lados y se actualiza aquí antes de implementarlo.

# Bot

Cómo funciona la conversación del bot por WhatsApp y hacia dónde va. La relación con el despacho (quién asigna la moto) está en [`CONTRATO-BOT-DESPACHO.md`](CONTRATO-BOT-DESPACHO.md).

## Principio: núcleo común, configuración por agencia

El sistema sirve a cualquier agencia de domicilios, no solo al primer cliente. Lo que varía entre agencias se configura; el núcleo es el mismo y funciona igual para todas.

| Núcleo (igual para todas) | Configurable por agencia |
|---|---|
| Flujo: dirección → cotización → confirmación → viaje → despacho → avisos | Qué datos son obligatorios para confirmar un pedido |
| Restaurante reconocido por su número | Textos y tono de los mensajes |
| Geocodificación una vez por dirección | Tabla de precios por km |
| Cotización por distancia | Zona de servicio (ciudad, límites del mapa) |
| Contrato con el despacho | Cuándo se escala a un asesor |

Regla para construir: si algo solo aplica a un cliente, va a la configuración, no al código del flujo.

## Flujo básico (lo primero que se construye)

El restaurante ya está registrado: por su número se conoce su nombre, su dirección y sus coordenadas de recogida.

1. **Todo empieza con una dirección de entrega.** Cotizar o pedir, siempre llega una dirección. Si el mensaje no la trae (y no es solo un saludo), se le pide.
2. **Siempre se cotiza primero.** Con la dirección se geocodifica una vez, se calcula la distancia desde el restaurante y se responde con el precio y un botón **«Confirmar servicio»**.
3. **Al confirmar:**
   - si el primer mensaje ya traía todos los datos obligatorios, se crea el viaje y se despacha;
   - si faltan, se le dice exactamente cuáles y se espera un mensaje con ellos; con eso se crea el viaje.
4. **Despacho y avisos:** se asigna la moto y se avisa al restaurante (nombre y teléfono del domiciliario) y al motorizado (ficha del viaje).
5. **Motorizado:** confirma «Recogido» y «Entregado»; cada uno se le avisa al restaurante.

Datos obligatorios del primer cliente: **dirección de entrega** y **tiempo de preparación**. El método de pago (efectivo o transferencia) no es obligatorio.

**Imágenes:** un pedido puede llegar como foto. Se lee con un modelo de visión; si no es legible, se le pide que lo escriba.

Mensajes por pedido: dos en el mejor caso (pedido completo + confirmar). La meta es que los restaurantes aprendan a enviar todo en el primer mensaje.

## Decisiones del flujo

| | Decisión |
|---|---|
| Confirmación | Botón «Confirmar servicio» o escrita: el tiempo de preparación, "sí", "dale", "ya está". Dar el tiempo después de la cotización también confirma |
| Tono | Corto con lo esencial: «Serían $6.000 hasta Valle del Lili 🛵» |
| Cobertura | Km máximo por calles desde el restaurante (`settings.bot_config.maxKm`, 15 por defecto) |
| Datos obligatorios | `settings.bot_config.requiredFields`; por defecto dirección de entrega y tiempo de preparación |
| Ubicación | Dirección escrita (se geocodifica una vez) o pin de WhatsApp (coordenadas exactas, sin costo) |
| Notas | Lo que no es un campo (con cuánto paga el cliente, qué lleva, torre y apto) va en `trips.notes` y sale en la ficha del motorizado |
| Citar mensajes | Todo aviso sobre un pedido responde citando el mensaje con que el restaurante lo pidió. Cada mensaje guarda su wamid y su viaje, para saber de qué pedido habla el restaurante cuando cita uno nuestro |
| Cambios a un pedido creado | «Ya está listo», «se demora 5 más», «paga con 50» cambian el pedido, no abren otro. Cuál: el que citó; si no citó y hay uno abierto, ese; con varios, se pregunta con botones. Se le avisa al motorizado citando su ficha. Cambiar la dirección de un pedido creado pasa a un asesor |
| Espera antes de responder | 6 s desde el último mensaje (`REPLY_DELAY_MS` en `apps/bot/src/bot/intake.ts`). Leído al 25 % y «escribiendo…» al 50 % del tiempo, para que se sienta natural. Junta los mensajes partidos en uno |

## Para después

Capas que se agregan una vez el flujo básico funcione:

- **Sin confirmación para restaurantes que ya saben cómo es.** Reconocer a los que siempre envían el pedido completo, o que conocen los precios y no quieren confirmar, y crear el viaje directo. Habría que definir cómo se gana ese trato (por historial o marcado a mano) y cómo se quita.
- **Registro de restaurantes nuevos.** Un número desconocido entra a un flujo de registro con botones (nombre, dirección de recogida), con opción de pasar a un asesor.
- **Escalar a un asesor con botones**, en vez de solo por intentos fallidos.

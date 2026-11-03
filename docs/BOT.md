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
   Si falta algún dato obligatorio, se pide **en el mismo mensaje de la cotización** («Para despacharlo envíame…»): el restaurante confirma y completa en una sola respuesta.
3. **Al confirmar** con todo, se crea un viaje por entrega y se despacha. Si todavía falta algo, se le dice exactamente qué.
4. **Despacho y avisos:** se asigna la moto y se avisa al restaurante (nombre y teléfono del domiciliario) y al motorizado (ficha del viaje).
5. **Motorizado:** recibe la ficha y toca **«Terminé el servicio»** cuando termina. No acepta ni rechaza: si no puede, lo escribe (ver «Motorizados»).

Datos obligatorios del primer cliente: **dirección de entrega** y **tiempo de preparación**. Además, para toda agencia: si la dirección es un conjunto, unidad o edificio, **torre y apartamento** (o número de casa).

**El cobro no es asunto de la agencia.** Cuánto se le cobra al cliente, si ya pagó o si paga en efectivo es entre el restaurante, el cliente y el motorizado: no se exige ni se liquida. Si el restaurante lo dice, va informativo en la ficha. Los motorizados manejan su propia plata y su base.

**Imágenes:** un pedido puede llegar como foto o captura. Se lee con el modelo (visión) junto con el texto que la acompañe; si no se puede abrir, se le pide que lo escriba. En el chat de prueba: `/imagen <ruta> [texto]`.

## La dirección: el formato lo pone la agencia

El cliente quiere sistematizar los datos: que el restaurante se acomode al formato de la agencia, no al revés. Para la dirección:

- **Calle, número y barrio** (o un lugar conocido: clínica, centro comercial). Si no se encuentra en el mapa, se pide con número completo y barrio, o la ubicación.
- **Conjunto, unidad, edificio o condominio:** se exige **torre y apartamento** (o casa). El modelo marca `esConjunto` y guarda la torre y el apto en `detalleDireccion`, aparte de la dirección, para no volver a ubicar ni cotizar cuando llegan después.
- En la ficha sale `Calle 5 # 66-20, Edificio Torre Alta, El Refugio · Apto 1203`; el enlace de Waze usa solo la calle (o las coordenadas, si las hay).

**Precio solo por distancia.** No hay cobro por zonas ni tarifa por defecto: sin la dirección ubicada en el mapa no se cotiza. Si Google falla, el pedido pasa a la central; si la tabla de rangos por km está vacía, también. Detalle, ubicación simulada para pruebas y zonas sin cobertura: [DIRECCIONES-Y-ZONAS.md](DIRECCIONES-Y-ZONAS.md).

## Mensajes por servicio

Cada mensaje que el bot envía cuesta (mensajes de servicio en Colombia: unos US$0,0008 cada uno pasados los 1.000 gratis al mes por número). La meta es el mínimo posible sin dejar de cumplir. Lo de base, en el mejor caso:

| A quién | Mensaje | Se puede apagar |
|---|---|---|
| Restaurante | Cotización (con lo que falte y el botón) | No |
| Restaurante | Confirmado: quién va y su teléfono | No |
| Restaurante | Servicio terminado | Sí: `settings.bot_config.notifyRestaurantOnDelivery` (encendido) |
| Motorizado | Ficha del viaje con el botón | No |
| Motorizado | «Terminado, quedas libre» | Sí: `confirmDeliveryToCourier` (apagado: el botón ya le muestra que lo tocó) |

**Tres mensajes por servicio** con la configuración por defecto. Lo que no se manda nunca: aceptar o rechazar el servicio, recordatorios de efectivo, reenviar la ficha cada vez que el motorizado escribe. El «leído» y el «escribiendo…» no se cobran.

Medirlo: `npm run bot:mensajes` (últimos 30 días) o `npm run bot:mensajes -- 2026-10-01`. Da los mensajes a restaurantes y a motorizados, el promedio por servicio y el costo mensual estimado.

## Motorizados

Lo normal es que no escriban. Cuando escriben, el bot clasifica el mensaje (`apps/bot/src/services/openai/courier.ts`):

| Mensaje | Qué pasa |
|---|---|
| «Ok», «voy», «ya recogí», «listo» | Nada: no se responde |
| «Mándame la dirección», «la ficha» | Se le reenvía la ficha |
| Novedad: «me accidenté», «no puedo ir», «el cliente no baja», «cancelo» | Queda **en pausa** (no se le asigna nada más, conserva lo que lleva), su chat pasa a la central con el motivo, y se le responde «Recibido 🙏 La central ya te contacta». Ante la duda, se trata como novedad |
| Escribe estando desconectado y sin viajes | Queda conectado |

**Sin base:** si el motorizado no tiene cambio y le toca volver al restaurante, el servicio no ha terminado: toca «Terminé el servicio» al volver. Mientras tanto sigue ocupado y no se le asigna otro.

Qué hace la central con una novedad: [INTERVENCION-MANUAL.md](INTERVENCION-MANUAL.md).

## Decisiones del flujo

| | Decisión |
|---|---|
| Confirmación | Botón «Confirmar servicio» o escrita: el tiempo de preparación, "sí", "dale", "ya está". Dar el tiempo después de la cotización también confirma |
| Tono | Corto con lo esencial: «Serían $6.000 hasta Valle del Lili 🛵» |
| Cobertura | Km máximo por calles desde el restaurante (`settings.bot_config.maxKm`, 15 por defecto) |
| Datos obligatorios | `settings.bot_config.requiredFields`; por defecto dirección de entrega y tiempo de preparación |
| Ubicación | Dirección escrita (se geocodifica una vez) o pin de WhatsApp (coordenadas exactas, sin costo) |
| Notas | Lo que no es un campo (con cuánto paga el cliente, qué lleva, referencias) va en `trips.notes` y sale en la ficha del motorizado. La torre y el apto van en la dirección |
| Citar mensajes | Todo aviso sobre un pedido responde citando el mensaje con que el restaurante lo pidió. Cada mensaje guarda su wamid y su viaje, para saber de qué pedido habla el restaurante cuando cita uno nuestro |
| Varias entregas | Un pedido puede traer varias direcciones (dos clientes en un mensaje, o «y otro para…»). Se cotizan en un solo mensaje con el total y un botón «Confirmar los N», se confirman juntas y cada una sale en su propio viaje. Una corrección («perdón, el de Pance es…») reemplaza la dirección, no agrega otra |
| Cambios a un pedido creado | «Ya está listo», «se demora 5 más», «paga con 50» cambian el pedido, no abren otro. Cuál: el que citó; si no citó y hay uno abierto, ese; con varios, se pregunta con botones. Se le avisa al motorizado citando su ficha. Cambiar la dirección de un pedido creado pasa a un asesor |
| Consultas | «¿Ya llegó?», «¿quién va?»: el estado de cada pedido (buscando moto, quién va con su teléfono, entregado a qué hora), del que citó o de todos los abiertos y entregados en las últimas 3 horas. «¿Domis acá?» sin dirección: se le pide la dirección o la ubicación; con dirección, se cotiza (la cobertura sale del km máximo) |
| Espera antes de responder | 6 s desde el último mensaje (`REPLY_DELAY_MS` en `apps/bot/src/bot/intake.ts`). Leído al 25 % y «escribiendo…» al 50 % del tiempo, para que se sienta natural. Junta los mensajes partidos en uno |

## Para después

Capas que se agregan una vez el flujo básico funcione:

- **Sin confirmación para restaurantes que ya saben cómo es.** Reconocer a los que siempre envían el pedido completo, o que conocen los precios y no quieren confirmar, y crear el viaje directo. Habría que definir cómo se gana ese trato (por historial o marcado a mano) y cómo se quita.
- **Registro de restaurantes nuevos.** Un número desconocido entra a un flujo de registro con botones (nombre, dirección de recogida), con opción de pasar a un asesor.
- **Escalar a un asesor con botones**, en vez de solo por intentos fallidos.

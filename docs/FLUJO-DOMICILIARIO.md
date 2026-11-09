# Flujo del domiciliario y estados del servicio

Plan acordado para guiar al domiciliario por WhatsApp, saber en qué va cada servicio y avisar cuando un pedido queda en portería. Estado: **fases 1 a 5 construidas y funcionando en staging con el simulador** (motos simuladas y números de prueba que reciben sus mensajes). Falta la fase 0 y probar con domiciliarios y celulares reales ([PLAN.md](PLAN.md) D-1).

## Objetivo

- Que el domiciliario se organice solo desde WhatsApp, con la información justa en cada momento.
- Que Williams vea en el portal en qué va cada servicio, sin tener que llamar.
- Que el restaurante sepa cuándo se entregó de verdad y si quedó en portería, para avisarle a su cliente.
- Gastar los menos mensajes posibles por servicio.

La agencia nunca le escribe al cliente final. Con él hablan el restaurante y, si hace falta, el domiciliario por teléfono.

## Hoy y por qué se cambia

El viaje está «en ruta» desde que se asigna hasta el final. Solo se guarda «Vi el pedido» y «Terminé el servicio», y este último significa a la vez «entregué» y «quedé libre». Eso causa lo siguiente:

- Si toca «Terminé» al entregar y aún debe volver al restaurante, puede salirle otro pedido.
- Si lo toca al volver, el restaurante recibe «entregado» tarde y con esa hora.
- Williams no sabe si ya recogió, si va a entregar o si está volviendo.
- Nadie se entera de que un pedido quedó en portería.
- El motor cree que toda moto ocupada aún debe recoger (`apps/bot/src/dispatch/engine-request.ts`).

## El flujo nuevo

### Mensaje 1: al asignar

Lleva solo lo necesario para ir a recoger:

- Lugar de recogida, con detalles (local, entrada).
- A qué hora está listo.
- Waze hacia el lugar de recogida.
- Barrio de destino y cobro, para que sepa antes de salir si necesita base o datáfono.

Botones: **«Voy en camino»** y **«Recogí»**.

### Mensaje 2: al tocar «Recogí»

Lleva lo necesario para entregar:

- Dirección, torre y apartamento.
- Cliente y teléfono.
- Indicaciones.
- Waze hacia la entrega.

WhatsApp permite máximo 3 botones de respuesta, con títulos de 20 caracteres. Por eso las opciones van en una **lista** (hasta 10 filas, títulos de 24 caracteres), que se abre con el botón «Marcar entrega»:

| Opción | Entrega | ¿Queda libre? |
|---|---|---|
| Entregado, terminé | Al cliente | Sí |
| Entregado, vuelvo | Al cliente | No, vuelve a recogida |
| En portería, terminé | En portería | Sí |
| En portería, vuelvo | En portería | No, vuelve a recogida |

Portería va como opción aparte y no dentro de «entregado», porque ese es el problema que tiene Williams: hoy no le avisan cuándo un pedido queda ahí.

No hace falta un botón de «terminado» para todos: las opciones con «terminé» cierran el servicio en un solo paso.

### Mensaje 3: solo si debe volver

Al elegir una opción con «vuelvo» se le envía el botón **«Ya volví»**, que cierra ese servicio. Con GPS (fase 5), este mensaje desaparece.

### Tocar un botón no tiene respuesta

Tocar un botón no se cobra y el toque queda visible en su chat, pero eso no le confirma que quedó registrado. Por eso, al terminar el servicio se le responde «✅ A-08 terminado.», salvo que ya le haya llegado otro pedido, que le sirve de confirmación. No se le dice que quedó libre, porque puede llevar otro. «Voy en camino» no tiene respuesta: es el paso de menos riesgo.

Los pasos se pueden saltar: elegir una entrega también cuenta como recogido, y «Recogí» también cuenta como «Voy en camino». Un botón olvidado no daña el flujo.

Lo que escriba también sirve: «voy», «ya recogí», «lo dejé en portería» y «ya volví» hacen lo mismo que el botón. Ante la duda, sigue aplicando la regla de novedades de [BOT.md](BOT.md).

## Aviso al restaurante

Sale al marcar la entrega, con la hora real, aunque el domiciliario siga en camino de regreso. Reemplaza el «entregado» de hoy, así que no suma mensajes.

| Caso | Mensaje |
|---|---|
| Al cliente | 📦 Pedido B-12 entregado a las 7:40 p. m. ✅ |
| En portería | 📦 Pedido B-12 quedó en portería a las 7:40 p. m. ✅ Para Laura Méndez, torre 4 apto 302. Ya puedes avisarle al cliente. |

El aviso de portería sale siempre, aunque la agencia haya apagado `notifyRestaurantOnDelivery`: es el que el restaurante necesita para actuar.

## Estados en el portal

Cada tarjeta de Viajes y cada domiciliario en Flota muestran una etiqueta con el tiempo que lleva en ese estado. Se dice «recogida» y no «restaurante», porque no todo servicio se recoge en un restaurante.

| Etiqueta | Cuándo | Origen |
|---|---|---|
| Por asignar | Sin moto | Ya existe |
| Sin leer | Asignado y WhatsApp no ha avisado que lo leyó | Asignación |
| Leído | Lo leyó, pero no ha tocado «Voy en camino» | Aviso de lectura de WhatsApp |
| Va a recoger | Tocó «Voy en camino» | Botón |
| Llevando el pedido | Tocó «Recogí» | Botón |
| Volviendo a recogida | Entregó y eligió «vuelvo» | Botón |
| Entregado | Entregó al cliente | Botón |
| En portería | Lo dejó en portería | Botón |
| Cancelado | Se canceló | Ya existe |
| En punto de recogida | Entró a la zona de recogida | GPS, fase 5 |
| En punto de entrega | Entró a la zona de entrega | GPS, fase 5 |

Algunos domiciliarios tienen desactivada la confirmación de lectura, así que «Sin leer» no prueba que no lo haya visto.

## Recordatorios

Solo salen si hacen falta, y cada uno se envía una vez por asignación. La alerta del portal no gasta mensajes.

| Si falta | Cuándo | Qué pasa |
|---|---|---|
| «Voy en camino» | Lo último entre 3 min desde la asignación y 10 min antes de que esté listo | Recordatorio citando el mensaje 1 |
| «Voy en camino» | 3 min después del recordatorio | Alerta en rojo en el portal |
| «Recogí» | 10 min después de la hora de listo | Alerta en el portal y un recordatorio: «El pedido B-12 ya está listo en…» |
| «Ya volví» | 20 min de regreso (por confirmar con Williams) | Solo alerta en el portal |
| Marcar la entrega | 30 min después de «Recogí» (por confirmar con Williams) | Solo alerta en el portal |

No se cuenta solo desde la asignación porque la cola asigna aunque la comida tarde 30 minutos, y eso daría alarmas falsas. Los tiempos son una propuesta y van en `settings.bot_config`.

## Mensajes por servicio

Meta cobra solo lo que enviamos: lo que escribe o toca el usuario no se cobra. Hay 1.000 mensajes de servicio gratis al mes por número, y luego unos US$0,0008 cada uno en Colombia (por confirmar en la tabla oficial).

| A quién | Mensaje | Cantidad |
|---|---|---|
| Restaurante | Cotización | 1 |
| Restaurante | Confirmación | 1 |
| Restaurante | Entregado o en portería | 1 |
| Domiciliario | Mensajes 1 y 2 | 2 |
| Domiciliario | Terminado, salvo que ya le haya llegado otro pedido | 1 |
| **Total** | | **6** |

Suman uno más cada uno de estos casos:

- Pedir un dato que faltaba.
- Avisar quién va, si no había moto libre.
- Un recordatorio.
- «Ya volví», si debe regresar.
- Una consulta del restaurante.
- Cada mensaje de Williams desde el portal.

## Fases

### Fase 0: antes de construir

1. Confirmar el método de pago en la cuenta de Meta. Sin él, Meta dejó de entregar los mensajes de servicio desde el 1 de octubre de 2026.
2. Confirmar la tarifa de Colombia en la tabla oficial de Meta.
3. Probar en un celular real:
   - Si «Recogí» sigue activo después de tocar «Voy en camino». Si se desactiva, se enciende `pickupButtonAfterGoing`: «Recogí» sale en un mensaje aparte y suma uno por servicio.
   - Si la lista es cómoda desde la moto. Si no lo es, hay que definir otra opción con 3 botones.
4. Resolver con Williams las preguntas de abajo.

### Fase 1: datos y etiqueta en el portal

- Migración `0012`: nuevas columnas en `assignments`.
  - `read_at`, `picked_up_at`, `delivery_place` (`customer` o `gate`), `return_started_at`, `finished_at`, `pickup_reminder_at`. Los viajes anteriores no se reescriben: sin `return_started_at` cuentan como cerrados.
  - `seen_at` pasa a significar «Voy en camino», para no perder las métricas de Flota.
  - Debe aplicarse antes de desplegar el bot, porque `assignments` se lee con `select()`.
- Al reasignar, limpiar también las columnas nuevas (`assignNextCourier`).
- Separar `completeTrip` en dos pasos:
  - **Entregar:** el viaje pasa a `delivered` y guarda la hora y el lugar. Así el arqueo cuenta bien, porque ya lee `status` y `deliveredAt`.
  - **Terminar:** guarda `finished_at` y libera la moto, solo si no le queda otro viaje abierto. Hoy la libera aunque lleve otro.
- Cambiar lo que considera activo un viaje, para incluir a quien va de regreso (`openTripCondition`): `activeTrips` del bot, `apps/bot/src/dispatch/shadow.ts` y el tablero.
- Una función común en `packages/shared` calcula el estado a partir de esas horas.
- Portal: etiqueta en `TripCard` y en Flota. Un servicio de regreso sigue en la columna de en ruta.
- Portal: el botón «Entregado» pregunta dónde quedó y si el domiciliario sigue ocupado. Revisar también el camino que marca entregado en `apps/portal/src/db/queries/trips.ts`.
- Dejar de usar `requiresCashReturn`: no se puede deducir el regreso del método de pago, y hoy nada lo usa.

### Fase 2: mensajes y botones

- Partir `courierTicket` en mensaje 1 y mensaje 2. La ficha que se reenvía depende de la fase.
- Waze hacia la recogida: coordenadas o, si no hay, la dirección escrita.
- Agregar `sendList` en `apps/bot/src/services/whatsapp/client.ts`. `normalize.ts` ya recibe las respuestas de lista.
- Nuevos botones en `handleCourier`. Los botones `seen:` y `deliver:` ya enviados siguen funcionando: el primero cuenta como «Voy en camino» y el segundo como «Entregado, terminé».
- Reconocer lo que escribe. Hoy «ya recogí» y «ya llegué» se ignoran.
- Nuevo aviso de portería al restaurante, y «¿ya llegó?» responde con la hora real y el lugar.
- Las indicaciones mezclan datos como «billete de 100 mil». Se repiten en los dos mensajes hasta separarlas.
- Probar primero con 2 o 3 domiciliarios.

### Fase 3: recordatorios y lectura

- Procesar los avisos de estado de Meta, que hoy `normalize.ts` descarta: `read` llena `read_at` y `failed` queda registrado y visible para la central.
- Adaptar `remindUnseen` y agregar el recordatorio de recogida.
- Nuevas alertas del portal.
- Corregir `bot:mensajes` para que cuente también los mensajes de Williams.

### Fase 4: algoritmo

- `engine-request.ts` envía las paradas reales: sin recogida si ya recogió, sin entrega si ya entregó.
- Nueva parada para el regreso. La parada `V` no sirve: significa devolver un pedido no entregado y saca a la moto de la evaluación.
- Las motos deben estar ocupadas siempre: quien está entregando o volviendo puede recibir otro pedido. El motor cuenta el peor caso, el regreso a recogida después de cada entrega, porque solo se sabe al entregar (`asumirRegreso`).
- Aplica con `settings.engine_config.mode = "auto"`, que es como está staging con el simulador. En `shadow` o `queue` la cola solo le asigna a motos libres.
- «Recogí» y la entrega quedan como datos del contrato, en [ALGORITMO.md](ALGORITMO.md) y [CONTRATO-BOT-DESPACHO.md](CONTRATO-BOT-DESPACHO.md).

### Fase 5: GPS con Traccar

El receptor (`/api/gps`) y la detección de llegadas (`apps/bot/src/bot/gps.ts`) ya están; falta instalar la app en los celulares. WhatsApp no sirve para esto, porque su API no admite ubicación en vivo.

| Con GPS | Qué cambia |
|---|---|
| No ha salido hacia la recogida | Alerta sin depender del botón |
| Se acerca a la recogida | Cuenta como «Voy en camino» |
| Llegó a la recogida | Etiqueta «En punto de recogida» |
| Salió de la recogida tras estar un rato, con la comida lista | Cuenta como «Recogí» y le llega el mensaje 2, si no lo había tocado |
| Llegó a la entrega | Etiqueta «En punto de entrega», si la dirección tiene coordenadas |
| Se fue sin marcar la entrega | Alerta a Williams |
| Volvió a la recogida | Cierra el servicio solo y elimina «Ya volví» |

**El botón de entrega se queda.** Llegar no prueba que se entregó, ni dice si quedó en portería. Los demás botones siguen de respaldo por si falla la señal.

Requisitos:

- Instalar la app en cada celular, con la notificación permanente y el ahorro de batería desactivado.
- Autorización por escrito y tiempo de retención definido (Ley 1581 de 2012).

Cómo se configura cada celular, con [Traccar Client](https://www.traccar.org/client/):

1. En Flota, «Ver más», generar el identificador GPS del domiciliario.
2. En la app: ese identificador y, como URL del servidor, `https://<host del bot>/api/gps`.
3. Precisión alta y reportar cada 10 a 15 segundos, también con la moto quieta: pasados 2 minutos sin reporte, la moto cuenta como sin señal y el algoritmo no la elige.

Para probar en local, `npm run bot:gps` mueve motos de ejemplo y reporta por la misma ruta.

### Probar en staging: el simulador

Con `SIMULATOR_ENABLED=1`, staging tiene motos simuladas que el algoritmo asigna en modo `auto` y que se mueven solas, reportando por `/api/gps` como lo hará Traccar. Los estados por ubicación los marca `gps.ts` con esas posiciones; ni el simulador ni el mapa los calculan. Cada número de prueba de Flota recibe por WhatsApp los mensajes de una moto simulada y toca sus botones, que entran por el mismo código de `handleCourier`. Las motos sin número marcan solas la entrega, por el mismo camino, y una parte (configurable) deja en portería, vuelve a recogida o reporta un cliente que no contesta.

Cómo se enciende y se usa: [OPERACION.md](OPERACION.md), «Simulador».

### Cliente que no contesta

La lista de entrega también trae «Cliente no contesta». El domiciliario espera hasta 10 minutos (`customerWaitMinutes`) sin recibir pedidos, y el restaurante recibe el aviso para contactar al cliente, porque la agencia nunca le escribe. Si el cliente sale, marca la entrega. Si no, le llega «Devolví el pedido», el restaurante se entera y, al tocarlo, el viaje se cancela. Hoy un pedido devuelto no suma al arqueo.

### Cuando la central interviene

- Un pedido pendiente se puede asignar a mano, con la lista de motos ordenada por cuántos pedidos llevan y a qué distancia están.
- Un pedido sin recoger se puede pasar a otra moto o dejar que se asigne solo. La moto anterior recibe un aviso.
- Si se desconecta una moto desde Flota, lo que no ha recogido se asigna de nuevo y termina lo que ya lleva.

## Preguntas para Williams

1. ¿Qué tan seguido vuelven al lugar de recogida? Define qué tanto importa «Ya volví».
2. ¿Cuántos pedidos puede llevar a la vez una moto? El motor usa 3 en hora pico y 2 en valle, y el de valle sigue sin confirmar.
3. ¿A los cuántos minutos alertar si no marca la entrega o no ha vuelto?
4. ¿Los tiempos de los recordatorios le sirven?
5. ¿El aviso de portería dice lo que el restaurante necesita?
6. Si el cliente nunca contestó y el pedido se devuelve, ¿se le cobra el domicilio al restaurante? ¿Se le paga al domiciliario?
7. ¿El restaurante necesita saber quién va? Con el algoritmo suele ser un mensaje más por servicio; se apaga con `notifyRestaurantOnAssign`.

## Riesgos

- **Que no toquen los botones.** Un estado mal marcado es peor que no tenerlo. Por eso se puede saltar pasos, se prueba primero con pocos y se miden los servicios cerrados por Williams.
- **Ventana de 24 horas.** Meta solo deja escribirle a quien nos escribió en las últimas 24 horas. Un domiciliario que lleva más tiempo sin escribir no recibe el mensaje 1, y por eso la fase 3 registra los fallos.
- **Pedidos múltiples.** Los mensajes siguen siendo por viaje; con varios, el mensaje 1 agrega «Tu orden». Dos pedidos del mismo restaurante son dos mensajes.
- **GPS en la calle.** Solo se ha probado con posiciones simuladas: falta medir el error real en conjuntos y zonas densas. Los 100 metros de llegada (`gpsArrivalMeters`) y el minuto de permanencia (`gpsDwellSeconds`) son una propuesta.

# Intervención manual

Estado: **en parte construido.** Ya existen la novedad del motorizado (lo pausa y pasa su chat a la central, ver [BOT.md](BOT.md), «Motorizados»), tomar o soltar un chat desde el portal, marcar la entrega, asignar o pasar un pedido sin recoger a otra moto, y los encargos (ver «Encargos»).

## La idea

No se le define a William (el despachador) un flujo por cada problema. Se le dan **pocas acciones sueltas** y él las combina como quiera. Cualquier caso raro (accidente, cliente que no baja, pedido dañado, restaurante que no entrega) se resuelve combinándolas. El sistema sugiere; él decide.

Mientras él atiende una novedad, **todo lo demás sigue solo**: los otros motorizados, los restaurantes y la asignación automática.

## Cómo arranca una novedad

1. **El motorizado la reporta escribiendo** («me accidenté», «el cliente no baja», «no puedo ir»). No hay botón de problema en la ficha: sería un mensaje más por servicio, y las novedades son la excepción.
2. Queda **en pausa**: no se le asigna nada más, pero no se desconecta; sus pedidos siguen siendo suyos hasta que William decida.
3. **Su chat pasa a la central** (el bot deja de responderle) con el motivo: «Novedad de Camilo (D-TY3PF): Se accidentó».
4. **A William le suena el celular** con una notificación del portal (ver «Alertas al celular»).
5. William también puede abrir una novedad él mismo, si se entera por una llamada.

## Las acciones

En el portal, cada motorizado y cada pedido tienen un menú.

**Motorizado**

| Acción | Qué hace |
|---|---|
| Pausar | No recibe pedidos nuevos; conserva los que lleva |
| Reactivar | Vuelve a la cola |
| Tomar el chat / devolverlo al bot | William le escribe directamente |
| Llamar | Abre la llamada desde el celular (`tel:`) |

**Pedido**

| Acción | Qué hace |
|---|---|
| Reasignar | Elige otro motorizado (ver abajo) y se le manda la ficha; al anterior se le avisa que ya no lo lleva |
| Devolver a la cola | Lo toma el siguiente libre, automático |
| Marcar entrega | Si el motorizado no pudo marcarla: dónde quedó. El servicio termina ahí |
| Editar datos | Dirección, teléfono, notas; si hay moto, se le avisa citando su ficha |
| Cancelar | Pide el motivo y qué se cobra (ver abajo) |
| Tomar el chat del restaurante | Le escribe directamente |

**Pendientes de regreso** (menú «Pendientes»): lo que un motorizado le debe a un restaurante, el datáfono o la plata de la comida. Normalmente lo declara él al recoger; la central puede registrar uno a mano cuando el restaurante reclama, tocar «Mandar ya» para que le llegue «Pasa por… a devolver el datáfono / a pagar», o marcarlo resuelto. Si un datáfono lleva más de 30 minutos afuera desde la entrega (se cambia ahí mismo), suena una alerta al celular. Detalle en [FLUJO-DOMICILIARIO.md](FLUJO-DOMICILIARIO.md), «Pendientes de regreso».

**¿A quién reasignar?** Al tocar «Reasignar» sale la lista de motorizados ordenada: primero los libres con la distancia al punto de recogida, después los que van en ruta con cuántos pedidos llevan. Él escoge.

**Cancelar y la contaduría.** En Viajes, cualquier pedido o encargo abierto (sin moto, asignado o en la calle) tiene **«Cancelar»** en su detalle. Se elige el motivo y se responden dos cosas:

- **¿Se cobra el domicilio?** Viene marcado por la regla de la agencia: si la moto ya salió del restaurante con el pedido (tocó «Recogí» o el GPS la vio salir), el restaurante paga el domicilio; si lo cancelan antes, no. La central lo cambia en un caso especial, como un accidente. Sin moto no hay nada que cobrar. Un encargo no marca recogida: lo decide la central.
- **¿Se le avisa al restaurante?** Marcado por defecto: «❌ Tu pedido A-57 quedó cancelado.», y si se cobra, cuánto y por qué. A la moto que lo llevaba se le avisa siempre, citando su ficha: que no vaya a recogerlo o, si ya lo tiene, que la central le dice qué hacer con él.

Lo cobrado cuenta en Finanzas como un viaje más de esa moto, el día en que se canceló, y la agencia saca su parte igual que de una entrega. Lo mismo un pedido devuelto porque el cliente no contestó: la moto ya había salido, así que se cobra el domicilio. La moto queda libre (si no lleva otro) y, si no lo había recogido, ese viaje no le cuenta en el turno. Si el restaurante había pedido cancelarlo por el chat («Pidió cancelar el pedido A-57»), el chat vuelve al bot. El cancelado queda en «Finalizado» con su motivo y lo cobrado.

Código: `cancelTrip` en `packages/shared/src/db/trip-lifecycle.ts`, la regla y los textos en `packages/shared/src/domain/trip-cancel.ts`, `POST /api/trips/:id/cancel`, el aviso en `notifyCancelled` (`apps/bot/src/bot/notify.ts`) y Finanzas en `apps/portal/src/db/queries/settlement.ts`. Pruebas: `apps/portal/src/app/api/trips/cancel.test.ts`.

**Registro.** Cada acción manual guarda quién, cuándo y por qué (una tabla `trip_events` o similar), para revisar reclamos después.

## Ejemplo

Camilo se accidenta llevando un pedido que ya recogió y tiene otro asignado.

1. Escribe «me accidenté». Queda en pausa y a William le suena el celular.
2. William lo llama.
3. Reasigna el pedido que Camilo no había recogido.
4. Cancela el dañado sin cobro y le escribe al restaurante desde el portal.
5. Cuando Camilo esté bien, lo reactiva.

Ningún paso lo impone el sistema.

## Encargos

A veces el restaurante no pide llevar su comida a un cliente, sino que le compren o le traigan algo: «necesito que me compren un queso tajado en la salsamentaria», «de ir al Ara a comprar 3 paquetes de tortillas», «Necesito un domi» + foto de un envase + «me traes 30». Son pocos y cada uno es distinto, así que no se automatizan: los coordina la central. El sistema no verifica nada del encargo (ni zona, ni precio, ni la tienda): solo avisa, y la central decide.

1. **Llega como un chat que pide ayuda.** El bot lo reconoce ([BOT.md](BOT.md), «Encargos»), le responde al restaurante «Le paso tu encargo a la central», pausa su chat con el motivo «Encargo: «…»» y suena la alerta «🛍️ Encargo · restaurante».
2. **La central lo acuerda en la conversación**, como cualquier chat escalado: qué hay que comprar, dónde y cuánto cuesta. Arriba del chat aparece el panel **«Encargo»**, con el campo del precio y dos botones:
   - **«Crear encargo»**: crea el viaje con el precio acordado (no se calcula ni se valida) y devuelve el chat al bot, que le confirma al restaurante «Listo ✅ Tu encargo A-15 quedó registrado. Te aviso cuando salga el domiciliario 🛍️».
   - **«No crear»**: no crea nada y devuelve el chat al bot, que no le escribe: la central ya le dijo lo que fuera.

   Los dos devuelven el chat al bot, así que si el restaurante pide luego un domicilio normal el bot lo atiende. Si otra persona ya lo decidió, el panel desaparece sin hacer nada (no se crean dos encargos).
3. **El encargo es un viaje** de tipo encargo (`trips.kind = errand`), con código de la misma serie que los demás. Guarda lo que pidió el restaurante tal cual (en `notes`, hasta 600 caracteres), el precio de la central (`deliveryFee`) y se entrega en el mismo restaurante (su dirección y ubicación registradas); no tiene recogida, porque la tienda la acuerda la central. Aparece en **Viajes, en Pendiente**, marcado **🛍️ Encargo** y con «Lo asignas tú».
4. **Solo la central lo asigna**, con el «Asignar» de siempre. El algoritmo nunca asigna un encargo, no lo cuenta para medir la demanda, y no le asigna otros pedidos a la moto mientras lo tenga.
5. **Al domiciliario le llega un solo mensaje con un solo botón, «✅ Entregado»**, y al restaurante «🛵 Va Carlos con tu encargo A-15.» (detalle en [FLUJO-DOMICILIARIO.md](FLUJO-DOMICILIARIO.md), «Encargos»). Los detalles («es en la de la 25, pide factura») y la foto que haya mandado el restaurante se los manda la central por el chat del domiciliario, y ahí revisa que todo llegó bien.
6. **Al tocar «Entregado»** el viaje queda entregado, la moto libre, y el encargo cuenta en Finanzas con su precio, como cualquier viaje. Si el domiciliario no pudo marcarlo, la central lo marca desde la tarjeta.

**Si la central decide no hacerlo**, se cancela como cualquier viaje: «Cancelar encargo» en el detalle de la tarjeta (ver «Cancelar y la contaduría»).

Un encargo no tiene recordatorios, GPS, botones de datáfono o plata, ruta, ni alertas de pedido bloqueado: lo sigue la central por el chat.

Código: el panel en `apps/portal/src/components/ErrandPanel.tsx` (acción `errand` de `POST /api/conversations/:id`), crear y no crear en `packages/shared/src/db/errands.ts`, y los mensajes en `apps/bot/src/bot/notify.ts`. Pruebas: `apps/portal/src/app/api/errands.test.ts` y `apps/bot/src/bot/errand.test.ts`.

## Alertas al celular

Las alertas del portal le llegan al celular como una notificación, igual que las de WhatsApp: suenan con el celular bloqueado y el portal cerrado. Al tocarla, el portal abre ese chat o ese pedido. Solo avisan lo que necesita a la central, en dos niveles:

- 🟠 **Naranja** (⚠️, ícono naranja, vibración normal): chat de un restaurante que pide ayuda, cliente que no contesta, reclamo de plata o datáfono, datáfono afuera (tarde o al cierre).
- 🔴 **Rojo** (🚨, ícono rojo, vibración larga y no se va hasta tocarla): chat de un motorizado que pide ayuda, moto en pausa en Flota (emergencia), moto que no recoge, entrega o devolución estancada.

No avisan la operación normal: una moto asignada, un pedido sin moto, un «Voy en camino» sin tocar o una moto que salió de la entrega sin marcarla se ven en la tarjeta de Viajes, sin notificación. Si la central ya escribió en un chat, las respuestas de los siguientes 5 minutos («ok gracias») tampoco avisan. No pasa por WhatsApp ni por Meta: no cuesta nada por aviso.

Son las mismas alertas que suenan con el portal abierto, ni más ni menos. «Chat que pide ayuda» incluye las novedades de un motorizado y las consultas de dirección, porque el bot las pasa a la central. Con el portal abierto en el computador, todo sigue sonando como antes.

Cada persona las activa en su propio celular. Les llegan a todos los que las activaron, sin elegir a nadie en el portal.

### Instalar el portal y activar las alertas

**Android (Chrome)**
1. Abre el portal en Chrome e inicia sesión.
2. Toca el menú **⋮** › **Agregar a la pantalla principal** (o **Instalar aplicación**) › **Instalar**. Queda el ícono de **Clapi**. Desde el portal también sirve el botón **Instalar Clapi** del menú **Alertas al celular**.
3. Abre **Clapi** desde el ícono: abre a pantalla completa, sin la barra del navegador.
4. Toca tu insignia (arriba a la derecha) › **Alertas al celular** › **Activar alertas** › **Permitir**. Llega una alerta de prueba.

**iPhone (Safari, iOS 16.4 o más reciente)**

Apple solo deja recibir notificaciones si el portal está en la pantalla de inicio y se abre desde ahí. Con un iOS más antiguo no se pueden.
1. Abre el portal en **Safari**.
2. Toca **Compartir** (el cuadro con la flecha) › **Agregar a inicio** › **Agregar**.
3. Abre **Clapi** desde el ícono e inicia sesión ahí. El iPhone guarda aparte la sesión de la app y la de Safari.
4. Insignia › **Alertas al celular** › **Activar alertas** › **Permitir**.

### Si no llegan o no suenan

- **Alertas al celular** dice en qué estado están en ese celular: *Activas*, *Apagadas* o *Bloqueadas en los ajustes*, y cómo desbloquearlas. **Enviar una de prueba** confirma que llegan.
- Si están bloqueadas, se desbloquean así:
  - Android: mantén presionado el ícono de Clapi › **Información de la app** › **Notificaciones**.
  - iPhone: **Ajustes** › **Notificaciones** › **Clapi**.

  Al volver al portal, el estado se actualiza solo.
- Suena el tono de notificaciones del celular (una página web no lo puede cambiar). Con el celular en silencio o en «No molestar», no suena.
- En Android, el ahorro de batería puede retrasarlas. Si pasa, quita a Chrome (o a Clapi) de la optimización de batería.

### Sesión de 30 días y celular perdido

En el portal instalado, la sesión dura 30 días: no pide la contraseña dos veces al día. En el navegador dura 12 horas, como antes. Si se entró desde el navegador y después se instaló, la sesión pasa a 30 días la primera vez que se abre desde el ícono.

Si se pierde un celular, entra al portal desde otro equipo › insignia › **Alertas al celular** › **Sesiones abiertas** y toca **Cerrar** en la de ese celular. Ese celular vuelve a pedir la contraseña y deja de recibir alertas en unos segundos. Cerrar sesión en el propio celular también apaga sus alertas. Al volver a entrar se reactivan solas, salvo que se hayan apagado a mano.

### Cómo funciona

- Cada 5 s, el tick del bot (`runPushAlerts`, `packages/shared/src/db/push.ts`) revisa las mismas condiciones que el portal abierto. Un chat suena cuando empieza a pedir ayuda, y vuelve a sonar si la central respondió y el restaurante escribe otra vez. Un viaje suena cuando queda con moto. `push_alert_state` guarda qué ya se avisó, así no se repite ni con dos ticks a la vez. Lo que pasó hace más de 10 minutos no se avisa: al encender esto no llueven avisos viejos.
- Cada notificación lleva una etiqueta por chat o por pedido: la nueva del mismo chat reemplaza a la anterior en vez de apilarse.
- Si mañana se agrega una alerta al portal, para que llegue al celular basta con agregar su fuente a `ALERT_SOURCES` en ese archivo, con su texto en `packages/shared/src/domain/alerts.ts`.
- Sesiones: tabla `portal_sessions`; la cookie firmada lleva su id, y cerrarla es borrar la fila. Suscripciones de cada celular: `push_subscriptions`, que cuelgan de la sesión. Las llaves con que el servidor firma los avisos (VAPID) se crean solas en `settings` (`web_push_vapid`). Si se borran, cada celular vuelve a registrarse al abrir el portal.

### Probado y pendiente

Probado en local de punta a punta: los avisos salen cifrados del bot, se abren en el chat o en el pedido, se dejan de enviar al cerrar la sesión, y la activación funciona en Chromium con un servicio de notificaciones real. Falta probar en staging con un Android y un iPhone reales: celular bloqueado, portal cerrado y sonido.

## Fases

1. ~~Novedad del motorizado: pausa y chat a la central.~~ Hecho.
2. ~~Alertas en el portal: notificación push (PWA) y sonido con el portal abierto~~ Hecho; falta probarlo en staging con celulares reales ([PLAN](PLAN.md) C-1).
3. Acciones del portal: ~~asignar a mano con la lista sugerida, pasar un pedido sin recoger a otra moto, emergencia y reactivar~~ (hecho); ~~cancelar con cobro~~ (hecho); falta el registro de acciones ([PLAN](PLAN.md) C-2).
4. ~~Liquidación: que cuente los cancelados con cobro.~~ Hecho.

La 3 y la 4 tocan el portal y la liquidación: coordinar con quien lleve el algoritmo (la reasignación debe pasar por el mismo despacho, ver [CONTRATO-BOT-DESPACHO.md](CONTRATO-BOT-DESPACHO.md)).

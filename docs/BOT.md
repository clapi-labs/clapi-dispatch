# Bot

Cómo funciona la conversación del bot por WhatsApp y hacia dónde va. La relación con el despacho (quién asigna la moto) está en [`CONTRATO-BOT-DESPACHO.md`](CONTRATO-BOT-DESPACHO.md).

## Principio: núcleo común, configuración por agencia

El sistema sirve a cualquier agencia de domicilios, no solo al primer cliente. Lo que varía entre agencias se configura; el núcleo es el mismo y funciona igual para todas.

| Núcleo (igual para todas) | Configurable por agencia |
|---|---|
| Flujo: dirección → cotización → confirmación → viaje → despacho → avisos | Qué datos son obligatorios para confirmar un pedido |
| Restaurante reconocido por su número y su nombre | Textos y tono de los mensajes |
| Geocodificación una vez por dirección | Tabla de precios por km |
| Cotización por distancia | Zona de servicio (ciudad, límites del mapa) |
| Contrato con el despacho | Cuándo se escala a un asesor |

Regla para construir: si algo solo aplica a un cliente, va a la configuración, no al código del flujo.

## Flujo básico (lo primero que se construye)

El restaurante ya está registrado: por su número se conoce su nombre, su dirección y sus coordenadas de recogida.

1. **Todo empieza con una dirección de entrega.** Cotizar o pedir, siempre llega una dirección. Si el mensaje no la trae (y no es solo un saludo), se le pide.
2. **Siempre se cotiza primero.** Con la dirección se geocodifica una vez y se calcula la distancia desde el restaurante. La respuesta depende de lo que quiere el restaurante (el modelo lo dice en `intencion`):
   - **Pide el servicio** (manda la dirección, los datos del cliente, «necesito un domi», un pin): «Serían $10.000 hasta El Refugio 🛵 ¿Queda confirmado?» con el botón **«Confirmar servicio»**. Si falta algún dato obligatorio, se pide **en la misma línea** («Si es así, envíame también…»): el restaurante confirma y completa en una sola respuesta.
   - **Solo pregunta el precio** («¿cuánto a Valle del Lili?», «¿qué vale hasta Pance?», «¿llegan a…?»): «Hasta Valle del Lili el domicilio vale $10.000 🛵», sin botón, sin pedir datos ni confirmación. A un «gracias» u «ok» no se le responde. Si pregunta por otra dirección, es otra cotización (no un segundo domicilio). Si después decide mandarlo («dale, mándalo», los datos del cliente, el tiempo), se vuelve pedido con el precio ya dado. Un pin después de un precio es un pedido aparte.
3. **Al confirmar** con todo, se crea un viaje por entrega y se despacha. Si todavía falta algo, se le dice exactamente qué.
4. **Despacho y avisos:** el restaurante siempre recibe la confirmación apenas confirma, haya moto libre o no: «✅ Servicio motorizado confirmado para el pedido B-12 · $7.000. 🛵 Va Wilians. El domiciliario estará ahí en 10 - 15 minutos» (solo el nombre, nunca el teléfono), y el motorizado su ficha. El tiempo lleva un margen implícito por tráfico (mayor en hora pico, 11:30–14:00 y 18:00–21:00) que no se le dice; el despacho busca que la moto llegue justo cuando la comida esté lista, así que por lo general llega antes. Si pasa de 15 minutos por nosotros (motos ocupadas o la más cercana viene lejos), se piden excusas y se dice la razón; si es porque la comida tarda más, «para cuando esté lista». Sin moto libre, cuando el despacho la asigna llega solo «🛵 Pedido B-12: va Wilians». Lo calcula `estimatePickup` en `apps/bot/src/bot/status.ts`.
5. **Motorizado:** recibe la información por partes ([FLUJO-DOMICILIARIO.md](FLUJO-DOMICILIARIO.md)). El primer mensaje lleva solo lo necesario para ir a recoger, con los botones **«Voy en camino»** y **«Recogí»** (también vale responder «ok», «voy», 👍). Al tocar «Recogí» le llega la dirección, el cliente y una lista para marcar la entrega: «Entregado, terminé», «Entregado, vuelvo», «En portería, terminé» o «En portería, vuelvo». Si vuelve, le llega el botón «Ya volví». Tocar un botón no se cobra: «Voy en camino» no tiene respuesta y al terminar se le confirma, salvo que ya le haya llegado otro pedido. Si no sale a tiempo, el bot se lo recuerda una vez citando el mensaje, y si sigue igual el viaje sale en rojo en el tablero para que la central lo llame o le pase el pedido a otra moto; pasarlo a otra moto lo decide una persona. En Flota, cada motorizado muestra en qué va y cuánto tarda en salir en promedio. Los tiempos se cambian en `settings.bot_config`. No acepta ni rechaza: si no puede, lo escribe (ver «Motorizados»).

Datos obligatorios por defecto: **dirección de entrega**, **nombre del cliente**, **teléfono del cliente** y **tiempo de preparación**. Además, para toda agencia: si la dirección es un conjunto, unidad o edificio, **torre y apartamento** (o número de casa). El teléfono se guarda en los 10 dígitos del celular, sin el +57; si no da 10 dígitos, se marca ❓ para que el restaurante lo confirme.

Un pedido perfecto trae todo en un mensaje y sale sin preguntas:

```
Carrera 85d #48-180, Comuna 17, Cali, Valle del Cauca, Colombia . Apto 401 torre C
+57 300 2637169
Lorena Mora
en 10
```

**El cobro no es asunto de la agencia.** Cuánto se le cobra al cliente, si ya pagó o si paga en efectivo es entre el restaurante, el cliente y el motorizado: no se exige ni se liquida. Si el restaurante lo dice, va informativo en la ficha. Los motorizados manejan su propia plata y su base.

**Imágenes:** un pedido puede llegar como foto o captura. Se lee con el modelo (visión) junto con el texto que la acompañe; si no se puede abrir, se le pide que lo escriba. En el chat de prueba: `/imagen <ruta> [texto]`.

**Lo leído se confirma antes de pedir la moto.** Si el pedido vino en una imagen, o el modelo no está seguro de algún dato (letra borrosa, un celular con dígitos de menos, «Cra 15 o 16»), la cotización empieza con lo que entendió («Esto leí en la imagen 👇»: dirección, cliente, teléfono, cobro, tiempo, notas) y marca con ❓ lo dudoso. El restaurante confirma con el botón o escribe el dato correcto. Con cada corrección se le muestra de nuevo cómo quedó, y la duda de ese dato desaparece. Confirmar acepta el precio y los datos. Un pedido escrito claro que trae los datos del cliente (nombre, celular, torre y apto o indicaciones) también muestra el resumen, sin ❓ («Esto entendí del pedido 👇»), para que el restaurante vea cómo quedó separado y que las indicaciones van para el domiciliario («📝 Para el domiciliario: …»). Solo una dirección, o una pregunta de precio, se cotiza directo, sin el resumen.

**Reconocer al restaurante.** El bot reconoce al restaurante por su número y su nombre (tabla `restaurants`) y asume su dirección y coordenadas de recogida, sin volver a geocodificar. El nombre es el que dice en el mensaje o, si no dice ninguno, el de su perfil de WhatsApp. Lo decide `domain/restaurant-identity.ts`:

| Número | Nombre | Qué hace el bot |
| --- | --- | --- |
| Registrado | Coincide, no viene o solo es el perfil (suele ser personal) | Lo atiende como ese restaurante |
| Registrado | Dice en el mensaje ser otro | Pregunta una vez «¿Hablo con Donde Lucho?». Solo un «no» pasa a la central. No crea ni renombra nada |
| No registrado | Coincide con uno sin número | Lo atiende como ese restaurante, le guarda el número y se lo avisa («Te reconocí como…») |
| No registrado | Coincide con uno que tiene otro número | Pasa a la central con el pedido guardado. El otro número no cambia |
| No registrado | Parecido a varios, no coincide o no viene | Restaurante nuevo |

Los nombres se comparan sin mayúsculas, tildes, orden ni palabras genéricas («La Nona Pizzería» = «Pizzería La Nona»), sin gastar una llamada. Si no son iguales, el modelo da un puntaje de 0 a 1 y el código decide: hace falta 0.85 y 0.15 de ventaja sobre el segundo. Una palabra que distingue («El Paisa Express» y «El Paisa») deja el puntaje en 0.8 como máximo, diga lo que diga el modelo. Si OpenAI falla, gana el número; sin número, sigue como restaurante nuevo y lo intenta otra vez con el siguiente mensaje. Un nombre escrito como destino o referencia («domi para…», «al lado de…») no cuenta como identificación. Cada nombre se compara una vez por pedido. Al cambiar el prompt, el modelo o el umbral: `npm run bot:eval:restaurantes`.

**El número de una moto gana:** un número registrado en Flota nunca se trata como restaurante.

Un restaurante nuevo dice de dónde se recoge en su primer pedido. Al confirmarlo, queda guardado (nombre de WhatsApp y dirección ubicada en el mapa) y se le avisa. Desde el siguiente pedido solo manda la dirección de entrega. También se puede registrar a mano: `npm run restaurant:create`.

## La dirección: el formato lo pone la agencia

El cliente quiere sistematizar los datos: que el restaurante se acomode al formato de la agencia, no al revés. Para la dirección:

- **Calle, número y barrio** (o un lugar conocido: clínica, centro comercial). Si no se encuentra en el mapa (o el mapa no responde), el bot **le pregunta a la central** si la dirección es válida y cuánto vale: al restaurante le dice «Ya le pregunto a la central… te aviso en un momento», guarda el pedido como va y se calla en ese chat. En el portal, la conversación sale arriba con el panel de la consulta: el asesor marca «Es válida» con el valor del domicilio (y corrige la dirección si hace falta) o «No es válida». Al responder, el bot retoma: manda el precio con el botón de confirmar (y pide lo que falte), o le pide al restaurante la dirección con número completo y barrio, o la ubicación. Una dirección validada así no tiene coordenadas: el enlace de Waze busca por la dirección escrita, y el despacho por cola la asigna igual (el algoritmo del engine, cuando exista, necesita coordenadas).
- **Si algo no cuadra, se le pregunta al restaurante.** Una dirección sin tipo de vía («la 42 con 83E-15»: ¿calle o carrera?), un celular sin 10 dígitos, dos nombres o teléfonos para el mismo cliente o un dato que cambia sin decir que es una corrección quedan como dudosos: el resumen los marca con ❓ y el restaurante confirma o corrige antes de pedir la moto. Esto vale también si la duda llega después de que ya confirmó.
- **Conjunto, unidad, edificio o condominio:** se exige **torre y apartamento** (o casa). El modelo marca `esConjunto` y guarda la torre y el apto en `detalleDireccion`, aparte de la dirección, para no volver a ubicar ni cotizar cuando llegan después. Si el modelo no lo marca pero la dirección dice «conjunto», «edificio», «torre», «bloque», «apto» o «unidad» sin el número de la puerta, el código lo pide igual (`looksLikeMultiUnit`).
- En la ficha sale `Calle 5 # 66-20, Edificio Torre Alta, El Refugio · Apto 1203`; el enlace de Waze usa solo la calle (o las coordenadas, si las hay).

**Precio solo por distancia.** No hay cobro por zonas ni tarifa por defecto: sin la dirección ubicada en el mapa no se cotiza. Si Google no ubica la dirección de entrega o falla, el bot le pregunta el precio a la central (ver arriba); si no ubica la recogida de un restaurante nuevo por una falla de Google, el chat pasa a la central; si la tabla de rangos por km está vacía, también. Detalle, ubicación simulada para pruebas y zonas sin cobertura: [DIRECCIONES-Y-ZONAS.md](DIRECCIONES-Y-ZONAS.md).

## Mensajes por servicio

Cada mensaje que el bot envía cuesta (mensajes de servicio en Colombia: unos US$0,0008 cada uno pasados los 1.000 gratis al mes por número). La meta es el mínimo posible sin dejar de cumplir. Lo de base, en el mejor caso:

| A quién | Mensaje | Se puede apagar |
|---|---|---|
| Restaurante | Cotización (con lo que falte y el botón) | No |
| Restaurante | Servicio motorizado confirmado: quién va (solo el nombre; nunca el teléfono del domiciliario: la agencia es la intermediaria) | No |
| Restaurante | Quién va (solo si la moto se asigna después de confirmar) | Sí: `notifyRestaurantOnAssign` (encendido). Con el algoritmo es lo normal, porque espera a que la comida casi esté |
| Restaurante | Entregado, con la hora real | Sí: `settings.bot_config.notifyRestaurantOnDelivery` (encendido). El de portería sale siempre |
| Motorizado | Mensaje 1: a dónde ir a recoger, con «Voy en camino» y «Recogí» | No |
| Motorizado | Mensaje 2: a dónde entregar, con la lista de entrega | No |
| Motorizado | «Ya volví», solo si debe volver (con GPS, el regreso se cierra solo, pero el botón sigue de respaldo) | No |
| Motorizado | Recordatorios si no sale o no recoge a tiempo (solo si hace falta) | Se ajustan en `settings.bot_config` |
| Motorizado | «A-08 terminado», salvo que ya le haya llegado otro pedido | Sí: `confirmDeliveryToCourier` (encendido) |

**Son seis mensajes por servicio** en el caso normal (cinco si con la entrega ya le llega otro pedido), con la configuración por defecto; cada recordatorio, regreso o dato que falte suma uno. Lo que no se manda nunca: aceptar o rechazar el servicio, recordatorios de efectivo, reenviar la ficha cada vez que el motorizado escribe. El «leído» y el «escribiendo…» no se cobran.

Medirlo: `npm run bot:mensajes` (últimos 30 días) o `npm run bot:mensajes -- 2026-10-01`. Cuenta los del bot y los de la central. Da los mensajes a restaurantes y a motorizados, el promedio por servicio y el costo mensual estimado.

## Motorizados

Lo normal es que no escriban. Cuando escriben, el bot clasifica el mensaje (`apps/bot/src/services/openai/courier.ts`):

| Mensaje | Qué pasa |
|---|---|
| «Ok», «voy», «ya lo vi», «listo», 👍 con un pedido sin confirmar | Cuenta como «Voy en camino» (el más viejo sin confirmar) |
| «Ya recogí», «entregado», «lo dejé en portería», «ya volví» | Lo mismo que el botón, si solo hay un pedido al que le aplique. Lo demás sigue a la clasificación |
| «Ok», «voy», «ya recogí», «listo» sin nada por confirmar | Nada: no se responde |
| «Mándame la dirección», «la ficha» | Se le reenvía la ficha |
| Novedad: «me accidenté», «no puedo ir», «el cliente no baja», «cancelo» | Queda **en emergencia** (rojo en Flota: no se le asigna nada más, conserva lo que lleva), su chat pasa a la central con el motivo, y se le responde «Recibido 🙏 La central ya te contacta». Ante la duda, se trata como novedad |
| Estados en Flota | **Gris** (desconectado): recién agregado o desconectado; se conecta escribiéndole al bot. **Verde**: libre. **Amarillo**: en un viaje. **Rojo** (emergencia): la marca la central desde Flota o la pone una novedad; no recibe pedidos, su bot queda pausado y su chat fijado arriba en Conversaciones. Al quitarla vuelve el bot y queda libre, o en viaje si todavía lleva algo |
| Pausa general | Botón «Pausar operación» del portal (`settings.business`), por ejemplo por lluvia. El bot no le responde a nadie y no entran pedidos nuevos; lo que está en curso sigue (el despacho asigna los pendientes, salen los avisos y los botones del motorizado funcionan). En Conversaciones todos los chats se escriben directo, sin intervenir, y al reanudar vuelven al bot |
| Escribe estando desconectado y sin viajes | Queda conectado |

**Sin base:** si el motorizado no tiene cambio y le toca volver al restaurante, marca la entrega con «vuelvo»: el restaurante recibe la hora real y él sigue ocupado hasta tocar «Ya volví». Solo él sabe si tiene que volver, porque depende de su base o del datáfono.

Qué hace la central con una novedad: [INTERVENCION-MANUAL.md](INTERVENCION-MANUAL.md).

## Decisiones del flujo

| | Decisión |
|---|---|
| Confirmación | Botón «Confirmar servicio» o escrita: el tiempo de preparación, "sí", "dale", "ya está". Dar el tiempo después de la cotización también confirma |
| Tono | Corto con lo esencial: «Serían $6.000 hasta Valle del Lili 🛵» |
| Cobertura | Km máximo por calles desde el restaurante (`settings.bot_config.maxKm`, 15 por defecto) |
| Datos obligatorios | `settings.bot_config.requiredFields`; por defecto dirección de entrega, nombre y teléfono del cliente, y tiempo de preparación. Lo que falte se pide en la misma cotización y otra vez al confirmar |
| Ubicación | Dirección escrita (se geocodifica una vez) o pin de WhatsApp (coordenadas exactas, sin costo) |
| Notas | Lo que no es un campo (con cuánto paga el cliente, qué lleva, puntos de referencia y cómo es el lugar) va en `trips.notes` y sale en la ficha del motorizado como «Indicaciones». Las referencias no van en la dirección (estorban al ubicarla) ni se resumen. La torre y el apto van en la dirección |
| Código del pedido | Una letra y dos cifras: `B-12`. El contador sube de 00 a 99 y al pasar de 99 cambia de letra y vuelve a 00 (A-99 → B-00); después de Z-99 vuelve a A-00. Se repite cada 2.600 pedidos, así que cuando el restaurante lo nombra se toma el más reciente de su conversación. Sale en todos los avisos, en la ficha y en el portal. Lo genera `packages/shared/src/db/trip-code.ts` con la secuencia cíclica `trip_code_seq` |
| Citar mensajes | Todo aviso sobre un pedido responde citando el mensaje con que el restaurante lo pidió. Cada mensaje guarda su wamid, su viaje y el mensaje que cita (`reply_to_wa_message_id`), para saber de qué pedido habla el restaurante cuando cita uno nuestro. El portal muestra la cita encima de la burbuja, como WhatsApp; tocarla lleva al mensaje citado |
| De qué pedido habla | El que citó; si no citó, el que nombra por su código («¿ya llegó el B-12?», «b12», «pedido B 12», «#B12»). Letra y cifras van pegadas o con guion; separadas por espacio solo después de «pedido» o «#», porque «a 20 minutos» no es un código |
| Varias entregas | Un pedido puede traer varias direcciones (dos clientes en un mensaje, o «y otro para…»). Se cotizan en un solo mensaje con el total y un botón «Confirmar los N», se confirman juntas y cada una sale en su propio viaje. Una corrección («perdón, el de Pance es…») reemplaza la dirección, no agrega otra |
| Cambios a un pedido creado | «Ya está listo», «se demora 5 más», «paga con 50», «es la torre 2 apto 301» cambian el pedido, no abren otro (la torre y el apto reemplazan los que hubiera en la dirección; la calle no cambia). Cuál: el que citó; si no citó y hay uno abierto, ese; con varios, se pregunta con botones. Se le avisa al motorizado citando su ficha. Cambiar la dirección de un pedido creado pasa a un asesor |
| Consultas | «¿Ya llegó?», «¿quién va?»: el estado de cada pedido (buscando moto, quién va —solo el nombre, con la nota de que lo que necesite del domiciliario lo pida por este chat—, entregado a qué hora), del que citó o nombró, o de todos los abiertos y entregados en las últimas 3 horas. Con varios, un mensaje por pedido citando el mensaje con que se pidió (uno más por pedido, a cambio de que se entienda cuál es cuál). «¿Domis acá?» sin dirección: se le pide la dirección o la ubicación; con dirección, se cotiza (la cobertura sale del km máximo) |
| Espera antes de responder | 6 s desde el último mensaje (`REPLY_DELAY_MS` en `apps/bot/src/bot/intake.ts`). Leído al 25 % y «escribiendo…» al 50 % del tiempo, para que se sienta natural. Junta los mensajes partidos en uno |

## Para después

Capas que se agregan una vez el flujo básico funcione:

- **Sin confirmación para restaurantes que ya saben cómo es.** Reconocer a los que siempre envían el pedido completo, o que conocen los precios y no quieren confirmar, y crear el viaje directo. Habría que definir cómo se gana ese trato (por historial o marcado a mano) y cómo se quita.
- **Registro de restaurantes nuevos.** Un número desconocido entra a un flujo de registro con botones (nombre, dirección de recogida), con opción de pasar a un asesor.
- **Escalar a un asesor con botones**, en vez de solo por intentos fallidos.

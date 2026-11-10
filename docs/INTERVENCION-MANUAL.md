# Intervención manual

Estado: **en parte construido.** Ya existen la novedad del motorizado (lo pausa y pasa su chat a la central, ver [BOT.md](BOT.md), «Motorizados»), tomar o soltar un chat desde el portal, marcar la entrega y asignar o pasar un pedido sin recoger a otra moto.

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
| Marcar entrega | Si el motorizado no pudo marcarla: dónde quedó y si debe volver |
| Ya volvió | Termina el servicio de quien estaba de regreso |
| Editar datos | Dirección, teléfono, notas; si hay moto, se le avisa citando su ficha |
| Cancelar | Pide el motivo y qué se cobra (ver abajo) |
| Tomar el chat del restaurante | Le escribe directamente |

**¿A quién reasignar?** Al tocar «Reasignar» sale la lista de motorizados ordenada: primero los libres con la distancia al punto de recogida, después los que van en ruta con cuántos pedidos llevan. Él escoge.

**Cancelar y la contaduría.** Al cancelar se responden dos preguntas:

- ¿Se le cobra el domicilio al restaurante? Sí / No / Otro valor
- ¿Se le paga al motorizado? Sí / No / Otro valor

Así un pedido dañado en un accidente queda en cero (o en lo que se acuerde por fuera) y la liquidación sale bien sola. Hoy la liquidación cuenta los viajes `delivered`; un cancelado con cobro tendría que sumar con el valor elegido.

**Registro.** Cada acción manual guarda quién, cuándo y por qué (una tabla `trip_events` o similar), para revisar reclamos después.

## Ejemplo

Camilo se accidenta llevando un pedido que ya recogió y tiene otro asignado.

1. Escribe «me accidenté». Queda en pausa y a William le suena el celular.
2. William lo llama.
3. Reasigna el pedido que Camilo no había recogido.
4. Cancela el dañado sin cobro y le escribe al restaurante desde el portal.
5. Cuando Camilo esté bien, lo reactiva.

Ningún paso lo impone el sistema.

## Alertas al celular

Las alertas del portal (un chat que pide ayuda a la central y una moto asignada) le llegan al celular como una notificación, igual que las de WhatsApp: suenan con el celular bloqueado y el portal cerrado. Al tocarla, el portal abre ese chat o ese pedido. No pasa por WhatsApp ni por Meta: no cuesta nada por aviso.

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
3. Acciones del portal: ~~asignar a mano con la lista sugerida, pasar un pedido sin recoger a otra moto, emergencia y reactivar~~ (hecho); falta cancelar con cobro y el registro de acciones ([PLAN](PLAN.md) C-2).
4. Liquidación: que cuente los cancelados según lo elegido ([PLAN](PLAN.md) C-2).

La 3 y la 4 tocan el portal y la liquidación: coordinar con quien lleve el algoritmo (la reasignación debe pasar por el mismo despacho, ver [CONTRATO-BOT-DESPACHO.md](CONTRATO-BOT-DESPACHO.md)).

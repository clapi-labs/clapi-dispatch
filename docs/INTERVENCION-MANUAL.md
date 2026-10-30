# Intervención manual

Estado: **por construir.** Lo que ya existe hoy: la novedad del motorizado (lo pausa y pasa su chat a la central, ver [BOT.md](BOT.md), «Motorizados») y tomar o soltar un chat desde el portal.

## La idea

No se le define a William (el despachador) un flujo por cada problema. Se le dan **pocas acciones sueltas** y él las combina como quiera. Cualquier caso raro (accidente, cliente que no baja, pedido dañado, restaurante que no entrega) se resuelve combinándolas. El sistema sugiere; él decide.

Mientras él atiende una novedad, **todo lo demás sigue solo**: los otros motorizados, los restaurantes y la asignación automática.

## Cómo arranca una novedad

1. **El motorizado la reporta escribiendo** («me accidenté», «el cliente no baja», «no puedo ir»). No hay botón de problema en la ficha: sería un mensaje más por servicio, y las novedades son la excepción.
2. Queda **en pausa**: no se le asigna nada más, pero no se desconecta; sus pedidos siguen siendo suyos hasta que William decida.
3. **Su chat pasa a la central** (el bot deja de responderle) con el motivo: «Novedad de Camilo (D-TY3PF): Se accidentó».
4. **A William le suena el celular** (ver «Alertas»).
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
| Marcar terminado | Si el motorizado no pudo tocar el botón |
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

- **Principal: WhatsApp al número personal de William.** El bot le manda «⚠️ Novedad: Camilo, D-TY3PF, se accidentó» con el enlace al portal. Llega siempre y en WhatsApp puede ponerle **un tono propio a ese contacto**. Si William no le ha escrito al número del bot en las últimas 24 h, tiene que salir como plantilla aprobada por Meta (de pago, unos centavos).
- **Respaldo: notificación push del portal.** Funciona en Android con Chrome aunque el navegador esté cerrado, si el portal se instala como app («Agregar a pantalla de inicio»). En iPhone, solo instalado en la pantalla de inicio (iOS 16.4+). El sonido no se puede personalizar desde la web.

Falta: **el número de WhatsApp de William.**

## Fases

1. ~~Novedad del motorizado: pausa y chat a la central.~~ Hecho.
2. Alerta por WhatsApp a William (plantilla en Meta).
3. Acciones del portal: reasignar con la lista sugerida, devolver a la cola, cancelar con cobro, pausar y reactivar, registro.
4. Liquidación: que cuente los cancelados según lo elegido.
5. Notificación push del portal (PWA).

La 3 y la 4 tocan el portal y la liquidación: coordinar con quien lleve el algoritmo (la reasignación debe pasar por el mismo despacho, ver [CONTRATO-BOT-DESPACHO.md](CONTRATO-BOT-DESPACHO.md)).

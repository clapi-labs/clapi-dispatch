# Plan de trabajo

Qué falta para llevar el sistema a producción con el cliente, dividido en objetivos y tareas. Cada tarea dice **qué** se busca y **cómo se sabe que quedó bien**; el cómo construirla lo decide quien la tome.

Estado al 8 de noviembre de 2026. Reemplaza a `PORTAL-PENDIENTES.md`, `PROPUESTAS_EQUIPO.md` y `SIMULACION.md`.

## Dónde estamos

Staging (`dev`, commit `1734609`) tiene el sistema completo funcionando con WhatsApp de prueba:

- **Bot:** reconoce al restaurante, cotiza por distancia, pide los datos con un formato, confirma con botón, crea un viaje por entrega, responde consultas y cambios. Un turno de mensajes seguidos recibe una sola respuesta ([BOT.md](BOT.md)).
- **Despacho:** el engine asigna en modo `auto` ([ALGORITMO.md](ALGORITMO.md)). Las motos son simuladas: en staging no hay flota real con GPS (ver «Simulador» en [OPERACION.md](OPERACION.md)).
- **Domiciliario:** mensajes guiados, botones, recordatorios, portería, cliente que no contesta ([FLUJO-DOMICILIARIO.md](FLUJO-DOMICILIARIO.md)).
- **Portal:** viajes con estados, flota, conversaciones, tarifas por km, finanzas del día, restaurantes, zonas sin cobertura, pausa general, mapa del simulador.

Lo que falta, en grande: un servidor de producción con backups y alertas, que el bot resuelva los casos que hoy terminan en la central, GPS real en las motos y que la central se entere de lo urgente sin estar mirando la pantalla.

## Cómo se trabaja

- **Una tarea, una rama, un PR.** La rama sale de `dev` actualizado (`git switch dev && git pull`) y se nombra por tipo: `feat/…`, `fix/…`, `docs/…`, `chore/…`. El PR va a `dev`, nunca a `main`.
- **Antes de abrir el PR:** `npm run lint`, `npm run typecheck`, `npm test` y `npm run build` en verde. Si cambia el esquema, la migración va en el mismo PR (ver `CLAUDE.md`).
- **El PR dice qué tarea cierra** (por su código, por ejemplo «B-1»), cómo se probó y cómo cumple el criterio de éxito. Lo revisa otra persona del equipo antes del merge.
- **La documentación se actualiza en el mismo PR**: el documento del tema y la tarea en este archivo (marcada como hecha, con el número del PR).
- **Después del merge**, se despliega en staging por hash y se comprueba ahí ([OPERACION.md](OPERACION.md), «Desplegar a staging»). Una tarea está terminada cuando su criterio de éxito se cumple **en staging**, no solo en local.
- **Si hace falta una decisión** que no está escrita aquí, se pregunta antes de construir. Lo que ya se decidió y no se debe reabrir está marcado como «Decidido».
- Reglas que no cambian: los secretos solo viven en `/opt/dispatch/.env`; el repositorio es público, así que nada de números de teléfono reales ni datos de clientes en el código, los commits o las pruebas; commits y PR en español, en el estilo del historial.

Tamaño aproximado: **S** hasta un día, **M** de dos a cuatro días, **L** una semana o más.

## Objetivos

| | Objetivo | Se cumple cuando |
|---|---|---|
| **I** | Producción lista y segura | El cliente usa un servidor de producción con datos reales, hay backup diario restaurable y el equipo se entera si algo se cae |
| **B** | El bot resuelve los pedidos sin la central | Un restaurante pide, corrige, cancela y consulta sin que la central tenga que arreglar el pedido a mano, salvo los casos que por regla le tocan a ella |
| **D** | El algoritmo asigna en la calle | Con motos reales y GPS, el engine asigna en `auto` y la central solo interviene en las excepciones |
| **C** | La central atiende lo urgente desde el portal | William se entera de cada novedad en su celular y la resuelve desde el portal, con la liquidación correcta |

Orden sugerido (cada ola puede repartirse entre varias personas):

1. **Primera ola:** I-1, I-2, I-4, B-1, B-2, C-4.
2. **Segunda ola:** I-3, I-7, B-3, C-1, D-1, D-2.
3. **Tercera ola:** I-5, I-6, B-4, B-5, C-2, C-3, D-3, D-4.

---

## I. Producción lista y segura

### I-1 · Backups de la base, restauración probada · Infra · M

**Objetivo:** que un daño del servidor no borre los pedidos, los chats ni la configuración. Hoy no hay ningún backup.

**Éxito:**
- Copia diaria de la base guardada **fuera** del servidor, con retención definida (por ejemplo, 14 días).
- Una restauración real hecha en una base vacía, con el tiempo que tomó anotado en `OPERACION.md`.
- Si la copia de un día falla, alguien del equipo se entera (puede usar el aviso de I-2).

**Dónde mirar:** `deploy/`, `docs/INFRAESTRUCTURA.md` («Backups»). Hetzner ofrece backups del servidor, pero no reemplazan un volcado de la base.

### I-2 · Aviso si el sistema se cae · Infra · S

**Objetivo:** enterarse de una caída antes que el cliente.

**Éxito:**
- Si `https://bot…/api/health` deja de responder `ok` o un contenedor queda sin salud por más de unos minutos, le llega un aviso al equipo.
- Probado en staging apagando el bot a propósito: llega el aviso y, al volver, el aviso de recuperación.

**Dónde mirar:** `apps/bot/src/app/api/health/route.ts`, healthchecks de `deploy/compose.yml`.

### I-3 · Despliegue automático a staging · Infra · M

**Objetivo:** que un merge a `dev` llegue a staging sin que nadie entre al servidor.

**Éxito:**
- Al terminar `images.yml` en `dev`, staging queda corriendo ese hash (`/opt/dispatch/.tag`).
- Si el despliegue falla, staging sigue en la versión anterior y el fallo se ve en Actions.
- La llave usada es la de despliegue restringida (solo puede correr `deploy.sh`), guardada como secreto de GitHub.

**Dónde mirar:** `.github/workflows/images.yml`, `deploy/deploy.sh`, `docs/INFRAESTRUCTURA.md` («CI/CD»).

### I-4 · CI en cada PR a `dev`, con las pruebas · Infra · S

**Objetivo:** que nada roto llegue a `dev`. Hoy CI solo corre en PR a `main` y no corre `npm test`.

**Éxito:**
- Todo PR a `dev` (y a `main`) corre lint, tipos, build, migraciones y `npm test`.
- Una prueba rota a propósito en un PR de ensayo bloquea el merge (protección de rama en `dev`).

**Dónde mirar:** `.github/workflows/ci.yml`, script `test` del `package.json` raíz.

### I-5 · Servidor de producción · Infra · L · depende de I-1, I-2

**Objetivo:** un entorno aparte para el cliente, sin nada compartido con staging.

**Éxito:**
- `infra/prod` creado con su propio estado de OpenTofu, dominio `dispatch.clapi.solutions`, `.env` y base propios.
- Se despliega con un botón (`workflow_dispatch`) **el mismo hash** que ya se probó en staging, sin reconstruir imágenes.
- Backups (I-1) y avisos (I-2) funcionando ahí desde el primer día.
- `SIMULATOR_ENABLED` y `AUTH_DISABLED` vacíos, y así lo comprueba el despliegue.

**Dónde mirar:** `infra/staging`, `infra/modules/server`, `docs/INFRAESTRUCTURA.md` («Entornos»), `docs/OPERACION.md` («Infraestructura»).

### I-6 · Repositorio privado · Infra · M

**Objetivo:** que el código deje de ser público sin romper los despliegues.

**Éxito:**
- El repositorio es privado y un despliegue a staging funciona después del cambio.
- `deploy.sh` baja `compose.yml` y el `Caddyfile` con un token de solo lectura que vive en el `.env` del servidor.
- Revisado el historial: cualquier secreto que haya estado público se rotó.

**Orden obligatorio:** primero el cambio en `deploy.sh` y el token en cada servidor, después comprobar con un despliegue, y solo entonces pasar a privado. Si se hace al revés, los despliegues fallan. Las imágenes de GHCR son públicas y un paquete público no se puede volver privado: ocultarlas requiere publicarlas de otra forma (`GHCR_USER`, `GHCR_TOKEN` en el servidor).

Pasar a privado no reemplaza el login: `AUTH_DISABLED` nunca se activa en un servidor con datos reales.

### I-7 · Recuperarse de una caída · Bot · M

**Objetivo:** que, al volver de una caída, el bot no responda mensajes viejos como si fueran nuevos ni cree pedidos duplicados.

**Éxito:**
- Confirmado y anotado por cuánto tiempo reintenta Meta los mensajes que no recibimos.
- Probado en staging: con el bot apagado 30 minutos, al volver los mensajes viejos se tratan de forma razonable (por ejemplo, la central los ve y el bot no cotiza algo de hace media hora) y no se crean pedidos dos veces.
- Un plan de contingencia escrito para la central: qué hace si el sistema cae en hora pico.

**Dónde mirar:** `apps/bot/src/app/api/webhook/whatsapp`, tabla `processed_messages`, `apps/bot/src/bot/intake.ts`.

---

## B. El bot resuelve los pedidos sin la central

### B-1 · Cancelar y vencer un pedido a medio armar · Bot · M

**Objetivo:** que un pedido que el restaurante no terminó no se mezcle con el siguiente. Pasó en staging el 8 de noviembre: un borrador de la madrugada se sumó a un pedido nuevo de la tarde y lo cotizó como tres domicilios.

**Éxito:**
- «Cancela ese pedido», «olvídalo», «ya no» borran el pedido a medio armar y el bot lo confirma en una línea.
- Un borrador sin mensajes durante un tiempo (proponer cuánto) no se mezcla con un pedido nuevo: el siguiente mensaje empieza de cero.
- Pruebas unitarias de los dos casos, y el caso del 8 de noviembre repetido con `npm run bot:chat`.

**Dónde mirar:** `apps/bot/src/bot/order.ts` (`handleRestaurant`), `conversations.draft`, el prompt de `packages/shared/src/domain/extraction.ts`.

### B-2 · Quitar o cancelar un pedido ya creado · Bot · S

**Objetivo:** que «quita el de la 42» o «cancela el B-12» después de confirmar no se confunda con un pedido nuevo. Hoy responde «Envíame la dirección de entrega».

**Éxito:**
- El bot reconoce que se refiere a un pedido creado (por cita, código o porque es el único abierto) y lo pasa a la central con el pedido identificado en el motivo.
- No crea ni cotiza nada nuevo, y la central lo ve en Conversaciones con el código del pedido.

**Decidido:** cancelar un pedido creado lo hace la central, no el bot (puede haber una moto en camino).

**Dónde mirar:** `apps/bot/src/bot/order.ts` (cambios a un pedido creado), `quitar` en `extraction.ts`.

### B-3 · Recogida de un restaurante nuevo verificada por la central · Bot + Portal · L

**Objetivo:** que ningún pedido de un restaurante nuevo salga con un punto de recogida que nadie revisó.

**Decidido:** la recogida de un restaurante nuevo se verifica a mano, desde la central. No se usa Google Places.

**Primero:** proponer el flujo y acordarlo antes de construir. Opciones que se hablaron: la central toma el chat y registra el restaurante en el portal; la central lo registra y el bot retoma solo; o el bot cotiza con Google y la central confirma la recogida antes de pedir la moto.

**Éxito:**
- Un restaurante nuevo nunca recibe moto con una recogida sin verificar.
- La central lo registra desde el portal, sin la terminal.
- Un restaurante guardado sin coordenadas deja de usar su nombre como dirección de recogida y de terminar en la central por error (fallo conocido).
- Medido en el servidor si Google ubica mejor la recogida con el nombre del restaurante delante de la dirección, o sin él, y anotado en `DIRECCIONES-Y-ZONAS.md`. La llave de Google solo funciona desde la IP del servidor.

**Dónde mirar:** `apps/bot/src/bot/order.ts` (recogida), `packages/shared/src/domain/restaurant-identity.ts`, `apps/bot/src/services/google/geocode.ts`, la página Restaurantes del portal.

### B-4 · Zonas sin cobertura en el bot · Bot · M

**Objetivo:** que el bot respete las zonas que el cliente marca en el mapa. Hoy se guardan (`restricted_zones`), pero el bot no las consulta.

**Éxito:**
- Recogida o entrega dentro de una zona: «Qué pena, pero hasta esa dirección no manejamos domicilio».
- A menos de 100 m del borde: el pedido queda en espera y la central decide en el portal con «Sí» o «No».
- Pruebas unitarias con polígonos de ejemplo (dentro, franja, fuera).

**Dónde mirar:** [DIRECCIONES-Y-ZONAS.md](DIRECCIONES-Y-ZONAS.md) («Por construir»), `packages/shared/src/db/restricted-zones.ts`, el panel de consulta de dirección del portal (sirve de base para el «Sí / No»).

### B-5 · Pedir torre y apartamento cuando hace falta · Bot · M

**Objetivo:** que el motorizado no llegue a un conjunto sin saber a quién buscar, sin pedirle la puerta a una casa.

**Éxito:**
- Primero, medido con los viajes guardados: cuántas entregas en conjuntos salieron sin torre ni apto.
- Una regla nueva que baje ese número, con pruebas. Ideas en [BOT.md](BOT.md), «Para después».
- Una dirección que ya tuvo pedidos con torre y apto la pide siempre.

**Dónde mirar:** `missingFields` y `looksLikeMultiUnit` en `apps/bot/src/bot/order.ts`.

---

## D. El algoritmo asigna en la calle

### D-1 · GPS real con los primeros domiciliarios · Despacho · M

**Objetivo:** que el engine tenga posiciones reales. Sin GPS, en producción toda moto cuenta «sin señal» y el engine no elige a nadie.

**Éxito:**
- Dos o tres domiciliarios con Traccar Client reportando durante un turno completo.
- Medido: porcentaje del turno con señal, y el error de las llegadas en conjuntos y zonas densas. Con eso se ajustan `gpsArrivalMeters` y `gpsDwellSeconds`.
- Autorización por escrito de cada domiciliario y tiempo de retención de las posiciones definido (Ley 1581 de 2012).

**Dónde mirar:** [FLUJO-DOMICILIARIO.md](FLUJO-DOMICILIARIO.md) («Fase 5»), `apps/bot/src/bot/gps.ts`, `/api/gps`.

### D-2 · Cuota justa y tiempo sin pedido · Despacho · M

**Objetivo:** que la equidad del engine use la cuota 1/N del turno y la hora real desde la que cada moto está disponible, como dice la especificación. Hoy usa el promedio de entregas del grupo.

**Éxito:**
- `engine-request.ts` envía la `cuota` y `disponible_desde_ts` reales de cada moto.
- Un caso nuevo en `apps/engine/casos/` donde la diferencia cambia la ganadora, y CI en verde.
- [ALGORITMO.md](ALGORITMO.md) actualizado: el punto 5 de «Lo que el bot tiene que aportar» marcado como hecho.

**Dónde mirar:** `apps/bot/src/dispatch/engine-request.ts`, [ALGORITMO.md](ALGORITMO.md) («Contrato»).

### D-3 · Tiempos de Google para las finalistas · Despacho · M

**Objetivo:** que el engine decida entre las tres mejores motos con tiempos reales de calle, no con línea recta.

**Éxito:**
- Verificado y anotado: si Google tiene modo moto en Colombia, el costo con el volumen real y lo que permiten sus términos sobre guardar resultados.
- Si conviene: una sola consulta por pedido para las finalistas, respaldo a Haversine si Google falla o pasa del tope diario, y el costo por pedido medido en staging.

**Dónde mirar:** [ALGORITMO.md](ALGORITMO.md) («Cómo calcula los tiempos»), `apps/engine/`.

### D-4 · Comparar el engine con la central · Despacho · M · depende de D-1

**Objetivo:** tener números para decidir pasar producción a `auto`.

**Éxito:**
- Con motos reales, unos días en modo `shadow`: una consulta o vista en el portal que muestre, por pedido, a quién habría asignado el engine y a quién asignó la central.
- Un criterio acordado con el cliente para pasar a `auto` (por ejemplo, tiempo de llegada a la recogida igual o mejor).

**Dónde mirar:** [ALGORITMO.md](ALGORITMO.md) («Modo sombra»), tabla `engine_evaluations`.

---

## C. La central atiende lo urgente desde el portal

### C-1 · Alertas al celular de la central · Portal · L

**Objetivo:** que a William le suene el celular con cada novedad aunque no tenga el portal abierto.

**Éxito:**
- El portal se instala como app y recibe notificaciones push (Android con Chrome; iPhone con iOS 16.4 o más).
- Suenan: novedad de un motorizado, chat que pide asesor, consulta de dirección, pedido que espera moto sin ganadora. Al tocar la notificación abre ese chat o ese pedido.
- El portal muestra si las notificaciones están activas en ese celular.
- Probado en un Android real con el navegador cerrado.

**Dónde mirar:** [INTERVENCION-MANUAL.md](INTERVENCION-MANUAL.md) («Alertas al celular»), `apps/portal/src/app/api/events`.

### C-2 · Cancelar con cobro y registro de acciones · Portal · L

**Objetivo:** que la central pueda cancelar un pedido decidiendo qué se cobra y qué se paga, y que toda acción manual quede registrada.

**Éxito:**
- «Cancelar» en un pedido pide el motivo, si se le cobra el domicilio al restaurante y si se le paga al motorizado (sí, no u otro valor).
- Finanzas cuenta los cancelados con el valor elegido, y también los pedidos devueltos por cliente que no contesta.
- Cada acción manual (asignar, pasar a otra moto, cancelar, marcar entrega) guarda quién, cuándo y por qué.
- Al motorizado que llevaba el pedido le llega el aviso.

**Dónde mirar:** [INTERVENCION-MANUAL.md](INTERVENCION-MANUAL.md) («Las acciones», «Fases»), `apps/portal/src/db/queries/settlement.ts`, `packages/shared/src/db/dispatch-queue.ts`.

### C-3 · Ver las imágenes que llegan a los chats · Portal + Bot · M

**Objetivo:** que la central vea las fotos y documentos que mandan restaurantes y motorizados. Hoy solo queda el texto `[Imagen]`.

**Éxito:**
- Las imágenes y los PDF que llegan se ven en el chat del portal y se abren con zoom propio (el portal bloquea el zoom de la página).
- Decidido y anotado dónde se guardan y por cuánto tiempo (depende de la coexistencia con WhatsApp Business; ver «Decisiones del dueño»).

**Fases siguientes, aparte:** enviar imágenes y PDF desde el portal; audios y video solo si hacen falta.

**Dónde mirar:** `apps/bot/src/bot/intake.ts` (`asText`), `apps/bot/src/services/whatsapp/`, la vista de Conversaciones.

### C-4 · Detalles del portal · Portal · S

Buena tarea para empezar a conocer el portal.

**Éxito:**
- Las fotos de restaurantes y domiciliarios salen también en la lista de chats, el encabezado del chat y las tarjetas de Viajes.
- El porcentaje de la agencia (hoy fijo en `AGENCY_RATE`, 10 %) se cambia desde el portal y se guarda en `settings`.
- Finanzas puede mostrar cuántos servicios hubo por método de pago.
- El botón «Ver más» de Flota con el mismo estilo del resto.

**Dónde mirar:** `apps/portal/src/components/`, `apps/portal/src/db/queries/settlement.ts`.

---

## Ideas sin tarea todavía

Se anotaron, pero falta definirlas antes de volverlas tarea:

- **Conversaciones del portal:** más fluidez y comodidad al escribir, y quitar lo que sobra.
- **«Pedir ubicación» en Flota:** un botón que le escribe al motorizado sin señal. Fuera de la ventana de 24 h necesita una plantilla aprobada por Meta.
- **Buscar o filtrar por restaurante** en Viajes, cuando haya muchos pedidos a la vez.
- **Sin confirmación para restaurantes de confianza** y **registro de restaurantes nuevos con botones** ([BOT.md](BOT.md), «Para después»).
- **Enviar imágenes y PDF desde el portal**, después de C-3.

---

## Decisiones y pendientes del dueño

No son tareas de desarrollo, pero varias tareas dependen de ellas.

**Con el cliente (William):**
- Las preguntas de [FLUJO-DOMICILIARIO.md](FLUJO-DOMICILIARIO.md), «Preguntas para Williams»: cuántos pedidos lleva una moto en valle, tiempos de alertas y recordatorios, cobro de un pedido devuelto.
- El criterio para pasar a `auto` en producción (D-4).

**Con Meta:**
- Método de pago en la cuenta (sin él, Meta no entrega mensajes de servicio desde el 1 de octubre de 2026) y la tarifa de Colombia en la tabla oficial.
- Token permanente de WhatsApp (usuario del sistema) para producción; el de pruebas dura unas 24 h.
- Coexistencia con WhatsApp Business: si está disponible en Colombia, si nos registramos como proveedor y si el número actual puede conectarse. De eso depende dónde se guardan las imágenes (C-3) y si el bot debe procesar `smb_message_echoes`.
- Probar en un celular real si «Recogí» sigue activo después de tocar «Voy en camino», y si la lista de entrega es cómoda desde la moto.

**Staging:**
- La tarifa «hasta 10 km» está en $5.000, menos que la de 4 km ($8.000); parece un error de digitación. Se corrige en Tarifas.
- El simulador está encendido y el engine en `auto`. Al terminar las pruebas: `SIMULATOR_ENABLED` vacío, redesplegar y decidir el modo.
- Revisar si algún domiciliario de Flota en staging es una persona real.
- Cambiar o borrar el usuario de pruebas con contraseña débil antes de usar datos reales.
- La rama `feat/simulador-staging` ya está toda en `dev`: se puede borrar.

**Del equipo:**
- Si las tareas pasan a GitHub Issues (un issue por tarea de este archivo, con el mismo código). Mientras el repositorio sea público, los issues también lo son.

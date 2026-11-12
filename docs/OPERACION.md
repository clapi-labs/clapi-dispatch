# Operación: acceso, cambios y despliegue

Guía práctica para cualquiera del equipo. El porqué de cada decisión está en [`INFRAESTRUCTURA.md`](INFRAESTRUCTURA.md).

## Guía rápida

```bash
# Entrar al servidor (la primera vez responde "yes" a la huella)
ssh -i ~/.ssh/clapi_ed25519 tu_usuario@staging.dispatch.clapi.solutions
cd /opt/dispatch

# Estado
docker ps                                   # todos (healthy)
cat .tag                                    # versión desplegada
docker logs --tail 50 dispatch-bot-1        # registros del bot

# Desplegar un commit (después de que images.yml esté en verde)
./deploy.sh deploy <hash-de-40-caracteres>  # git rev-parse HEAD en tu equipo

# Cambiar un secreto y aplicarlo
./set-secret.sh NOMBRE_VARIABLE
./deploy.sh deploy "$(cat .tag)"
```

Lo importante:
- Trabaja en una rama desde `dev` y vuelve con un PR a `dev`. El merge a `dev` construye las imágenes; desplegar aún es manual. Lo que hay por hacer: [`PLAN.md`](PLAN.md).
- Los secretos solo viven en `/opt/dispatch/.env`. Nunca en el repo ni en el chat.
- Para volver atrás, despliega el hash anterior.
- ¿Sin acceso? Sigue la sección 1: genera tu llave y pásale la `.pub` al administrador.

## Entornos y direcciones

| Entorno | Portal | Bot (webhook de Meta) |
|---|---|---|
| Staging | https://staging.dispatch.clapi.solutions | https://bot.staging.dispatch.clapi.solutions |

Salud del sistema: `https://bot.staging.dispatch.clapi.solutions/api/health` → `{"ok":true}` (200) o `{"ok":false}` (503). Qué falló queda en los registros del bot (`docker logs dispatch-bot-1 | grep health`). Lo vigila el monitoreo externo: ver «Avisos».

## 1. Entrar al servidor

### Conseguir acceso (una vez)
1. Genera tu llave **con contraseña** (la privada nunca sale de tu equipo):
   ```bash
   ssh-keygen -t ed25519 -f ~/.ssh/clapi_ed25519 -C "tu_nombre@clapi"
   cat ~/.ssh/clapi_ed25519.pub
   ```
2. Pásale la **pública** (`.pub`) al administrador de infraestructura. Él la agrega a `infra/access/admins.json` y corre `infra/scripts/sync-admins.sh`.
3. Nunca envíes el archivo sin `.pub`.

### Conectarse
```bash
ssh -i ~/.ssh/clapi_ed25519 tu_usuario@staging.dispatch.clapi.solutions
```
La primera vez SSH pregunta si confías en la huella del servidor: responde `yes`. Sin terminal interactiva (scripts, `BatchMode`) falla con «Host key verification failed» hasta que la huella esté guardada; se resuelve conectando una vez a mano o con `-o StrictHostKeyChecking=accept-new`.

Solo hay acceso por llave: sin `root` y sin contraseña. Tu usuario está en los grupos `dispatch-admins` y `docker`. Todo vive en `/opt/dispatch`.

### Quitar o dar acceso (administrador de infraestructura)
Editar `infra/access/admins.json` (usuario → llave pública), commitear y correr:
```bash
infra/scripts/sync-admins.sh tu_usuario@staging.dispatch.clapi.solutions
```
Crea las cuentas que falten, actualiza llaves, elimina las que ya no estén y reescribe `AllowUsers`. Se niega a correr con una lista vacía o inválida.

## 2. Flujo de trabajo y CI

1. Cada tarea en su propia rama desde `dev` actualizado (`feat/…`, `fix/…`, `docs/…`, `chore/…`), con un PR hacia `dev` que otra persona revisa. Commits en español, en el estilo del historial (ver `CLAUDE.md`).
2. Antes del PR, en tu equipo: `npm run lint`, `npm run typecheck`, `npm test` y `npm run build`. CI todavía no corre en los PR hacia `dev` ([PLAN](PLAN.md) I-4).
3. **Push a `dev` o `main`** (el merge del PR) → `images.yml` construye y publica las imágenes en GHCR con el hash del commit. **Esto no despliega nada.**
4. **PR de `dev` hacia `main`** → `ci.yml` corre lint, tipos, build, migraciones y la comprobación de esquema. Debe quedar en verde.
5. Cambios de esquema: edita `packages/shared/src/db/schema.ts`, corre `npm run db:generate` y commitea la migración nueva en `packages/shared/drizzle/`. Si falta, el CI falla.

Seguimiento: pestaña *Actions* del repositorio.

## 3. Desplegar a staging

Hoy el despliegue es **manual** (el automático está pendiente, ver `INFRAESTRUCTURA.md`).

1. Haz push a `dev` y espera a que `images.yml` termine en verde (así las imágenes de ese commit ya existen).
2. Copia el hash completo (40 caracteres): `git rev-parse HEAD`.
3. En el servidor:
   ```bash
   cd /opt/dispatch
   ./deploy.sh deploy <hash-de-40-caracteres>
   ```
   O desde tu equipo, sin entrar:
   ```bash
   ssh -i ~/.ssh/clapi_ed25519 tu_usuario@staging.dispatch.clapi.solutions '/opt/dispatch/deploy.sh deploy <hash>'
   ```

Qué hace `deploy.sh`, en orden:
1. Descarga `compose.yml` y `Caddyfile` **de ese commit** desde GitHub y los valida.
2. Baja las imágenes.
3. Levanta Postgres y corre las **migraciones**. Si fallan: error y no se toca nada.
4. Cambia las apps y espera a que estén sanas (`up --wait`, hasta 180 s).
5. Si algo no queda sano: muestra los registros y **vuelve a la versión anterior**.
6. Anota el hash en `/opt/dispatch/.tag`.

Versión activa: `cat /opt/dispatch/.tag`. Estado: `docker ps`. Para los contenedores usa `docker` y no `docker compose`: el compose necesita `IMAGE_TAG`, que solo pone `deploy.sh`.

### Volver atrás
Desplegar el hash anterior: `./deploy.sh deploy <hash-anterior>`. Cuidado: las migraciones no se revierten. Por eso deben ser compatibles con la versión previa (cambios de esquema en dos pasos).

### Cambios en `compose.yml` o `Caddyfile`
Se aplican solos: viajan con el commit que despliegas.

### Cambios en `deploy.sh`
No se actualiza solo (pertenece a root). Hay que copiarlo:
```bash
scp deploy/deploy.sh tu_usuario@staging.dispatch.clapi.solutions:/opt/dispatch/deploy.sh.new
ssh tu_usuario@staging.dispatch.clapi.solutions 'cd /opt/dispatch && sudo install -o root -g docker -m 755 deploy.sh.new deploy.sh && rm deploy.sh.new'
```

## 4. Secretos y configuración

Viven en `/opt/dispatch/.env`. Nunca los pegues en el chat, el repo ni la terminal en claro.

**Cambiar uno** (pide el valor oculto):
```bash
cd /opt/dispatch
./set-secret.sh NOMBRE_DE_LA_VARIABLE
./deploy.sh deploy "$(cat .tag)"     # las apps leen el .env solo al arrancar
```
Orden recomendado para rotar: generar el nuevo en el proveedor → `set-secret.sh` → redesplegar → comprobar `/api/health` → revocar el viejo.

**Ver qué variables hay sin ver valores:** `cut -d= -f1 /opt/dispatch/.env`

**Apagar o encender el bot:** `BOT_ACTIVE=false|true` con `set-secret.sh` y redesplegar.

## 4b. Simulador (solo staging)

Prueba el sistema completo con pedidos reales por WhatsApp sin un número por moto. Las motos simuladas son filas de `couriers` (marca «🧪 Simulada» en Flota, número `SIM<id>`, que no existe): el algoritmo y el portal las tratan como a cualquier moto. Un proceso aparte (`scripts/simulador.mjs`, servicio `simulator`, misma imagen que el worker) las mueve por sus paradas y reporta por `/api/gps`; no asigna, no envía y no marca estados. Si se cae o se detiene (`docker stop dispatch-simulator-1`), el bot y el portal siguen y las motos quedan sin señal: a los 30 s el algoritmo las excluye por «sin GPS».

**Encenderlo:**
```bash
cd /opt/dispatch
./set-secret.sh SIMULATOR_ENABLED      # el valor es 1 (no "true": compose lo usa como número de réplicas)
./deploy.sh deploy "$(cat .tag)"
```
Y el engine en modo `auto` ([ALGORITMO.md](ALGORITMO.md), «Modo auto»). Al arrancar crea 8 motos alrededor de los restaurantes registrados.

**Apagarlo:** `SIMULATOR_ENABLED` vacío y redesplegar. Sin ella no hay página `/simulador` (404), ni servicio `simulator` (0 réplicas), ni desvío de mensajes: cada moto recibe en su propio número, y el despacho deja de lado las simuladas. Nunca en producción.

**Números de prueba y motos reales.** Con el simulador encendido, una moto con número real de Flota (agregada con el formulario normal) es una de dos cosas:

- **Número de prueba**, si no tiene identificador de GPS: no recibe pedidos propios y toma la próxima moto simulada que reciba un pedido (abajo).
- **Moto real con GPS** («📡» en Flota y en el mapa), si tiene identificador de GPS: reporta su ubicación de verdad desde el celular, nunca toma una moto simulada y no recibe pedidos del simulador ni del algoritmo. Solo recibe el **viaje de prueba** que se le dé (abajo). Generar el identificador («Ver más» → GPS → «Generar») convierte un número de prueba en moto real y suelta la moto simulada que controlaba.

Los números de prueba:

1. Un número libre toma la próxima moto simulada sin número que reciba un pedido; con varios libres, el que lleva más tiempo libre.
2. Recibe el mensaje de ese pedido con el nombre de la moto («🧪 Moto simulada: Fabio») y, si la moto ya llevaba otros, el de cada uno en la fase en que va.
3. Conserva la moto hasta que no le quedan pedidos abiertos (con 15 s de margen para el «terminado»); entonces queda libre.
4. Lo que escribe o toca lo hace la moto: queda en el chat de la moto en el portal. Los botones se resuelven por el pedido; el texto, por la moto que controla.
5. La moto controlada sale cuando toca «Voy en camino», espera en la recogida a «Recogí» y en la entrega a que marque cómo quedó.
6. Si se quita o desconecta el número en Flota, su moto sigue sola sin perder sus pedidos. Sin números libres, la moto se maneja sola y sus mensajes solo quedan en su chat.

Cada número debe escribirle «hola» al bot antes de probar: así queda conectado y abre la ventana de 24 h de Meta.

**El mapa** (`/simulador`, en el menú; siempre pide sesión, aunque `AUTH_DISABLED=1`): motos con su estado, pedidos y ruta, restaurantes y clientes, el ranking de cada pedido tal como quedó en `engine_evaluations.response`, cuánto falta para despachar cada pedido que espera y qué moto controla cada número. Controles: velocidad, radio del engine, porcentajes de portería, regreso y cliente que no contesta, agregar moto, mover a mano (queda detenida ahí hasta «Soltar»), desconectar, crear un pedido sin WhatsApp y reiniciar.

**Viaje de prueba para una moto real.** La moto le escribe «hola» al bot (queda conectada) y tiene la app de GPS prendida. En el mapa, «Crear pedido sin WhatsApp» → «Para: 📡 Viaje de prueba para …» → elegir el restaurante y el cliente. El pedido se le asigna a ella como si lo hiciera la central: recibe los mensajes en su WhatsApp, y el GPS marca solo «en punto de recogida», «recogió» y «en punto de entrega». También se le puede asignar a mano un pedido desde Viajes. El número de la moto tiene que estar entre los destinatarios de prueba del número de staging en Meta.

**Reiniciar** borra solo lo simulado: las motos simuladas, sus chats, los pedidos que tuvieron y los creados desde el mapa. Restaurantes, usuarios y motos reales quedan igual.

**Límite:** la velocidad acelera el movimiento, no la cocina: el sistema usa la hora real. Para probar rápido, «listo en 5».

**Diagnóstico:** `docker logs --tail 50 dispatch-simulator-1`.

**Estado actual (8 de noviembre de 2026):** encendido, con el engine en `auto`. Apagarlo al terminar las pruebas ([PLAN](PLAN.md), «Decisiones y pendientes del dueño»).

## 4c. Conectar a un domiciliario al GPS

La ubicación en vivo llega de la app gratuita [Traccar Client](https://www.traccar.org/client/) en el celular del domiciliario, no de WhatsApp. Pasos y por qué: [FLUJO-DOMICILIARIO.md](FLUJO-DOMICILIARIO.md), «Fase 5».

1. En Flota, en su tarjeta, «Ver más» → GPS → **Generar**. Ese identificador es lo que autoriza a su celular: se le pasa solo a él.
2. En la app: el identificador y, como servidor, `https://<host del bot>/api/gps` (staging: `https://bot.staging.dispatch.clapi.solutions/api/gps`).
3. Al empezar el turno prende la app (además del «hola» por WhatsApp); al terminar la apaga.
4. En Flota → **Mapa**, o en su tarjeta: «En vivo» en menos de un minuto. Sin reporte en 30 s pasa a «Sin señal», con la hora de su última ubicación, y el algoritmo no la elige hasta que vuelva a reportar.

**Comprobar desde el servidor que llegan reportes:** `docker compose --env-file .env -f compose.yml exec -T postgres psql -U dispatch -d dispatch -c "select name, location_updated_at from couriers where simulated = false and location_updated_at is not null order by 2 desc"`.

**Las posiciones se borran a las 24 horas.** Solo se guarda la última de cada moto; la de una moto que lleva más de un día sin reportar se borra, y a las evaluaciones del algoritmo de más de un día se les quitan las posiciones de las motos. Lo hace el tick cada 10 minutos (`purgeOldPositions`, `packages/shared/src/db/gps-retention.ts`). Las horas de cada servicio (llegó, recogió, entregó) se conservan con el pedido.

## 5. Usuarios del portal

No hay registro público. Se crean en el servidor:
```bash
cd /opt/dispatch
./create-user.sh correo@dominio.com "Nombre"
```
Pide la contraseña oculta (mínimo 10 caracteres). Repetirlo con el mismo correo **cambia la contraseña**. Sin terminal interactiva se puede pasar con `USER_PASSWORD=... ./create-user.sh ...`, pero queda en el historial del shell: evítalo.

> El usuario de pruebas `express@cali.test` tiene contraseña débil. Cambiarla o borrarlo antes de usar datos reales.

Cada inicio de sesión queda en `portal_sessions`: 12 horas en el navegador y 30 días en el portal instalado en un celular. Para cerrar una sola (por ejemplo, la de un celular perdido), en el portal: insignia › **Alertas al celular** › **Sesiones abiertas** › **Cerrar**. Desactivar un usuario (`users.active = false`) cierra todas las suyas; cambiar `SESSION_SECRET` las cierra todas. Las alertas al celular y sus instrucciones: [INTERVENCION-MANUAL.md](INTERVENCION-MANUAL.md), «Alertas al celular».

## 6. Diagnóstico

```bash
docker logs --tail 50 dispatch-bot-1        # también: -portal-1, -worker-1, -caddy-1, -postgres-1
docker ps                                   # todos deben decir (healthy)
curl -s https://bot.staging.dispatch.clapi.solutions/api/health
```

| Síntoma | Causa probable |
|---|---|
| `/api/health` dice `{"ok":false}` | El motivo está en `docker logs dispatch-bot-1 \| grep health`: falta un secreto, la base no contesta, el worker no completa vueltas o el engine no responde en modo `auto` |
| Cambié un secreto y no surte efecto | Falta redesplegar |
| `deploy.sh` dice «Ya hay un despliegue en curso» | Otro despliegue activo; esperar |
| `deploy.sh` falla bajando imágenes | `images.yml` aún no terminó para ese hash, o el hash está mal |
| Meta no verifica el webhook | `WHATSAPP_VERIFY_TOKEN` distinto al de Meta, o URL equivocada |
| En los registros del bot: `envío rechazado 400 ... (#133010) Account not registered` | Los mensajes llegan, pero Meta rechaza el envío. Con el ID y el token correctos, mandar un mensaje de prueba desde *API Setup* en Meta reactiva el número de pruebas |
| El bot no responde | `BOT_ACTIVE` en `false`, token de WhatsApp vencido (el temporal dura ~24 h) o falla de OpenAI |
| Certificado no emitido | DNS aún sin propagar o puertos 80/443 cerrados |
| No llegan las alertas al celular | En ese celular, **Alertas al celular** dice si están activas o bloqueadas, y **Enviar una de prueba** las prueba. En los registros del bot y del portal, `[alertas]` dice qué rechazó el servicio de notificaciones |
| Un chat de prueba quedó con un pedido a medio armar que se mezcla con los nuevos | El borrador no vence ni se cancela todavía ([PLAN](PLAN.md) B-1). Se limpia a mano, abajo |

**Limpiar un chat de prueba** (solo staging): borra el pedido a medio armar y devuelve el chat al bot; los mensajes quedan.
```bash
docker exec dispatch-postgres-1 psql -U dispatch -d dispatch -c \
  "update conversations set draft = null, failed_attempts = 0, bot_paused = false, escalation_reason = null where phone = '<número>'"
```

## 6b. Avisos: si el sistema se cae

Un servicio **externo** revisa el sistema cada 5 minutos desde fuera del servidor (si el servidor se cae, no puede avisar él mismo) y avisa a un **grupo de Telegram de la empresa** cuando algo falla y cuando se recupera. Issue #51.

**Qué se vigila** (staging hoy; producción con los mismos pasos cuando exista):

| Monitor | Dirección | Falla si |
|---|---|---|
| Bot y sistema | `https://bot.staging.dispatch.clapi.solutions/api/health` | No responde 200. Responde 503 si falta configuración, la base no contesta, el worker lleva más de 2 minutos sin completar una vuelta (la asignación se detuvo) o el engine no responde con el modo `auto` |
| Portal | `https://staging.dispatch.clapi.solutions/login` | No carga (no responde 200) |

- `/api/health` hacia afuera solo dice `{"ok":true}` o `{"ok":false}`; el detalle queda en los registros del bot. Recuerda la respuesta 10 s, para que llamarlo seguido no cargue la base. Regla: `apps/bot/src/health/verdict.ts`.
- **El worker** anota la hora de cada vuelta completa en `settings` (`worker_tick`). Se guarda en la base, no en memoria: un reinicio del bot no lo pierde, y un despliegue (que reinicia el worker en menos de un minuto) no cuenta como detenido.
- **Docker no usa `/api/health`**, sino `/api/live` (el proceso está vivo; Caddy no la expone). Si Docker usara la completa, un despliegue que reinicia el worker o el engine parecería fallido y `deploy.sh` volvería atrás.

**Servicio y cuenta.** UptimeRobot, plan gratuito, con la cuenta de la **empresa** (correo compartido del equipo, 2FA, acceso de al menos dos personas; ver #41). Ningún token, enlace ni identificador del grupo de Telegram va en el repositorio, ni en issues, PRs o capturas: si una captura los muestra, se tapan.

**Configurarlo** (una vez por monitor; los nombres de los menús pueden cambiar):
1. En el grupo de Telegram, un administrador agrega el bot de UptimeRobot siguiendo la integración de Telegram de UptimeRobot (*Integrations → Telegram*). Queda como «contacto de alerta».
2. *New monitor* → tipo HTTP(s), la dirección de la tabla, intervalo de 5 minutos, y el contacto de alerta del grupo.
3. Para el bot, que cuente como caído cualquier respuesta distinta de 200 (es lo que hace por defecto).
4. Probar con «Test notification» que el mensaje llega al grupo.

**Quién recibe los avisos:** los miembros del grupo de Telegram de la empresa. Lo administra Jdavidruanob.
- **Agregar a alguien:** un administrador del grupo lo añade desde Telegram. No hay que tocar UptimeRobot.
- **Quitar a alguien:** se le saca del grupo el mismo día que sale del equipo (`docs/SEGURIDAD.md`, «Accesos»).

**Sumar producción u otro producto:** en la misma cuenta de UptimeRobot, crear sus monitores (su `/api/health` o equivalente y su página principal) con el **mismo contacto de alerta**. Que el nombre del monitor diga el producto y el entorno (por ejemplo «Dispatch · producción · bot»), porque los avisos de todos llegan al mismo grupo.

**Probarlo a propósito** (sin datos reales):

| Prueba | Cómo | Qué debe pasar |
|---|---|---|
| Bot apagado | `docker stop dispatch-bot-1` | Aviso en 10 min o menos; al `docker start`, el de recuperación |
| Worker detenido | `docker stop dispatch-worker-1` | Aviso (a los 2 min sin vueltas, más el intervalo del monitor) |
| Base detenida | `docker stop dispatch-postgres-1` | Aviso |
| Engine apagado en modo `auto` | `docker stop dispatch-engine-1` | Aviso. En `queue` o `shadow`, no |
| Despliegue normal | `./deploy.sh deploy "$(cat .tag)"` | Ningún aviso |

Al terminar cada prueba: `docker start …` y comprobar el aviso de recuperación.

## 7. Infraestructura (solo el administrador)

El token de Hetzner (`HCLOUD_TOKEN`) y el estado de OpenTofu están únicamente en su equipo.
```bash
set -a; . ~/.config/clapi/hcloud.env; set +a
cd infra/staging
tofu plan        # qué cambiaría, sin tocar nada
tofu apply       # aplica (pide confirmación)
```
- `terraform.tfstate` no se sube al repo ni se pierde: sin él, OpenTofu no reconoce los recursos. Guardar una copia aparte.
- `cloud-init` solo corre en el primer arranque; cambiarlo no modifica un servidor existente.
- Alta de servidor nuevo (p. ej. prod): copiar `infra/staging` a `infra/prod`, ajustar valores, `tofu apply`, apuntar el DNS, luego seguir `deploy/README.md` (crear `.env` y primer despliegue).

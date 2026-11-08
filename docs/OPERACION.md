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

Salud del bot: `https://bot.staging.dispatch.clapi.solutions/api/health` → `{"ok":true,"missing":[],"botActive":true}`. Si `missing` trae nombres, faltan secretos en el `.env`.

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

Prueba el sistema completo con pedidos reales por WhatsApp sin un número por moto. Las motos simuladas son filas de `couriers` (marca «🧪 Simulada» en Flota, número `SIM<id>`, que no existe): el algoritmo y el portal las tratan como a cualquier moto. Un proceso aparte (`scripts/simulador.mjs`, servicio `simulator`, misma imagen que el worker) las mueve por sus paradas y reporta por `/api/gps`; no asigna, no envía y no marca estados. Si se cae o se detiene (`docker stop dispatch-simulator-1`), el bot y el portal siguen y las motos quedan sin señal: a los 2 min el algoritmo las excluye por «sin GPS».

**Encenderlo:**
```bash
cd /opt/dispatch
./set-secret.sh SIMULATOR_ENABLED      # el valor es 1 (no "true": compose lo usa como número de réplicas)
./deploy.sh deploy "$(cat .tag)"
```
Y el engine en modo `auto` ([ALGORITMO.md](ALGORITMO.md), «Modo auto»). Al arrancar crea 8 motos alrededor de los restaurantes registrados.

**Apagarlo:** `SIMULATOR_ENABLED` vacío y redesplegar. Sin ella no hay página `/simulador` (404), ni servicio `simulator` (0 réplicas), ni desvío de mensajes: cada moto recibe en su propio número, y el despacho deja de lado las simuladas. Nunca en producción.

**Números de prueba.** Con el simulador encendido, toda moto con número real de Flota (agregada con el formulario normal) es un número de prueba: no recibe pedidos propios y toma la próxima moto simulada que reciba un pedido.

1. Un número libre toma la próxima moto simulada sin número que reciba un pedido; con varios libres, el que lleva más tiempo libre.
2. Recibe el mensaje de ese pedido con el nombre de la moto («🧪 Moto simulada: Fabio») y, si la moto ya llevaba otros, el de cada uno en la fase en que va.
3. Conserva la moto hasta que no le quedan pedidos abiertos (con 15 s de margen para el «terminado»); entonces queda libre.
4. Lo que escribe o toca lo hace la moto: queda en el chat de la moto en el portal. Los botones se resuelven por el pedido; el texto, por la moto que controla.
5. La moto controlada sale cuando toca «Voy en camino», espera en la recogida a «Recogí» y en la entrega a que marque cómo quedó.
6. Si se quita o desconecta el número en Flota, su moto sigue sola sin perder sus pedidos. Sin números libres, la moto se maneja sola y sus mensajes solo quedan en su chat.

Cada número debe escribirle «hola» al bot antes de probar: así queda conectado y abre la ventana de 24 h de Meta.

**El mapa** (`/simulador`, en el menú; siempre pide sesión, aunque `AUTH_DISABLED=1`): motos con su estado, pedidos y ruta, restaurantes y clientes, el ranking de cada pedido tal como quedó en `engine_evaluations.response`, cuánto falta para despachar cada pedido que espera y qué moto controla cada número. Controles: velocidad, radio del engine, porcentajes de portería, regreso y cliente que no contesta, agregar moto, mover a mano (queda detenida ahí hasta «Soltar»), desconectar, crear un pedido sin WhatsApp y reiniciar.

**Reiniciar** borra solo lo simulado: las motos simuladas, sus chats, los pedidos que tuvieron y los creados desde el mapa. Restaurantes, usuarios y motos reales quedan igual.

**Límite:** la velocidad acelera el movimiento, no la cocina: el sistema usa la hora real. Para probar rápido, «listo en 5».

**Diagnóstico:** `docker logs --tail 50 dispatch-simulator-1`.

**Estado actual (8 de noviembre de 2026):** encendido, con el engine en `auto`. Apagarlo al terminar las pruebas ([PLAN](PLAN.md), «Decisiones y pendientes del dueño»).

## 5. Usuarios del portal

No hay registro público. Se crean en el servidor:
```bash
cd /opt/dispatch
./create-user.sh correo@dominio.com "Nombre"
```
Pide la contraseña oculta (mínimo 10 caracteres). Repetirlo con el mismo correo **cambia la contraseña**. Sin terminal interactiva se puede pasar con `USER_PASSWORD=... ./create-user.sh ...`, pero queda en el historial del shell: evítalo.

> El usuario de pruebas `express@cali.test` tiene contraseña débil. Cambiarla o borrarlo antes de usar datos reales.

## 6. Diagnóstico

```bash
docker logs --tail 50 dispatch-bot-1        # también: -portal-1, -worker-1, -caddy-1, -postgres-1
docker ps                                   # todos deben decir (healthy)
curl -s https://bot.staging.dispatch.clapi.solutions/api/health
```

| Síntoma | Causa probable |
|---|---|
| `/api/health` con `missing` no vacío | Falta un secreto en el `.env` |
| Cambié un secreto y no surte efecto | Falta redesplegar |
| `deploy.sh` dice «Ya hay un despliegue en curso» | Otro despliegue activo; esperar |
| `deploy.sh` falla bajando imágenes | `images.yml` aún no terminó para ese hash, o el hash está mal |
| Meta no verifica el webhook | `WHATSAPP_VERIFY_TOKEN` distinto al de Meta, o URL equivocada |
| En los registros del bot: `envío rechazado 400 ... (#133010) Account not registered` | Los mensajes llegan, pero Meta rechaza el envío. Con el ID y el token correctos, mandar un mensaje de prueba desde *API Setup* en Meta reactiva el número de pruebas |
| El bot no responde | `BOT_ACTIVE` en `false`, token de WhatsApp vencido (el temporal dura ~24 h) o falla de OpenAI |
| Certificado no emitido | DNS aún sin propagar o puertos 80/443 cerrados |
| Un chat de prueba quedó con un pedido a medio armar que se mezcla con los nuevos | El borrador no vence ni se cancela todavía ([PLAN](PLAN.md) B-1). Se limpia a mano, abajo |

**Limpiar un chat de prueba** (solo staging): borra el pedido a medio armar y devuelve el chat al bot; los mensajes quedan.
```bash
docker exec dispatch-postgres-1 psql -U dispatch -d dispatch -c \
  "update conversations set draft = null, failed_attempts = 0, bot_paused = false, escalation_reason = null where phone = '<número>'"
```

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

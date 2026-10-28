# Infraestructura

Todo corre en un VPS de Hetzner, sin Vercel. Este documento describe **qué hay y por qué**. Cómo operarlo (entrar, desplegar, cambiar secretos) está en [`OPERACION.md`](OPERACION.md); el algoritmo de asignación, en [`ALGORITMO.md`](ALGORITMO.md).

## Estado

| Pieza | Estado |
|---|---|
| Servidor de staging (Hetzner, OpenTofu) | Hecho |
| HTTPS automático (Caddy + Let's Encrypt) | Hecho |
| Portal con login, bot, worker, Postgres | Hecho, funcionando en staging |
| Migraciones versionadas (Drizzle) | Hecho |
| CI (lint, tipos, build, migraciones) | Hecho, corre en PR hacia `main` |
| Publicación de imágenes en GHCR | Hecho, en cada push a `dev` y `main` |
| Despliegue automático desde GitHub | **Pendiente** (hoy se despliega a mano, ver `OPERACION.md`) |
| Servidor de producción (separado de staging) | Pendiente |
| Backups | Pendiente (desactivados a propósito por ahora) |
| Motor de asignación (`engine`) | Imagen y servicio listos, con casos en CI; el bot todavía no lo llama |
| GPS (Traccar) | Pendiente |

## Arquitectura de un entorno

Staging y producción tienen **esta misma estructura**, cada uno en su propio servidor. Por eso se dibuja una sola vez; más abajo se ve cómo se relacionan los dos.

```mermaid
flowchart TB
    subgraph Externos
        WA[WhatsApp - Meta]
        OAI[OpenAI]
        GM[Google Maps]
        TR[Traccar - GPS del motorizado]
    end

    DESP[Despachador - navegador]
    DEV[Equipo - SSH]

    subgraph GH[GitHub]
        REPO[Repo + Actions]
        GHCR[GHCR - imágenes]
    end

    subgraph VPS[Servidor Hetzner - solo puertos 22, 80 y 443]
        CADDY[Caddy - HTTPS y rutas]

        subgraph STG[Proyecto Compose - red interna Docker]
            BOT[bot - webhook WhatsApp]
            PORTAL[portal - con login]
            WORKER[worker - cada 5 s]
            PG[(Postgres)]
            ENGINE[engine - algoritmo]
        end
    end

    WA -- webhook --> CADDY
    TR -.-> CADDY
    DESP -- HTTPS --> CADDY
    CADDY -- "solo /api/webhook/whatsapp y /api/health" --> BOT
    CADDY --> PORTAL

    BOT --> WA
    BOT --> OAI
    BOT -- geocoding --> GM
    BOT --> PG
    PORTAL --> PG
    PORTAL -- "/api/internal" --> BOT
    WORKER -- "/api/internal/tick" --> BOT
    BOT -.-> ENGINE
    ENGINE -.-> GM

    REPO --> GHCR
    GHCR -- pull --> VPS
    REPO -. "deploy.sh por SSH" .-> VPS
    DEV -- "SSH personal" --> VPS

    classDef pendiente stroke-dasharray: 5 5
```

Las líneas y cajas punteadas son lo que falta. Cada entorno usa su propio número de WhatsApp, su propia base y su propio `.env`. El restaurante y el motorizado solo hablan con WhatsApp.

## Entornos y flujo de cambios

Dos servidores distintos, con la misma estructura y nada compartido (ni base, ni secretos, ni número de WhatsApp). Cada rama lleva a un entorno.

```mermaid
flowchart LR
    DEVR[Rama dev] -- push --> IMG1["images.yml: construye imágenes"]
    IMG1 --> GHCR[(GHCR - imágenes por hash)]
    GHCR -- "deploy.sh deploy hash" --> STG

    subgraph STG[Servidor staging]
        S1["staging.dispatch.clapi.solutions<br/>número de prueba de Meta<br/>base de pruebas"]
    end

    STG -- "el equipo prueba" --> OK{Funciona}
    OK -- sí --> PR[PR de dev a main]
    PR --> CI["ci.yml: lint, tipos, build, migraciones"]
    CI -- merge --> MAIN[Rama main]
    MAIN -- "botón: desplegar el mismo hash probado" --> GHCR
    GHCR -- "deploy.sh deploy hash" --> PRD

    subgraph PRD[Servidor producción]
        P1["dispatch.clapi.solutions<br/>número real del cliente<br/>base con datos reales"]
    end

    OK -- no --> DEVR
```

| | Staging | Producción |
|---|---|---|
| Rama | `dev` | `main` |
| Servidor | Hetzner CX23 (existe) | Otro Hetzner (pendiente: `infra/prod`) |
| Portal / bot | `staging.dispatch…` / `bot.staging.dispatch…` | `dispatch…` / `bot.dispatch…` |
| WhatsApp | Número de prueba de Meta | Número real del cliente |
| Datos | De prueba, se pueden borrar | Reales, con backups |
| Cómo se despliega | Automático al push (pendiente; hoy a mano) | Por botón, con un hash ya probado en staging |
| Quién entra por SSH | Todo el equipo | Solo quien lo necesite |

Reglas del flujo:
- **Lo que llega a producción es la misma imagen que se probó en staging**: se despliega el hash, no se reconstruye.
- Todo cambio pasa primero por `dev` y staging. Nada va directo a `main`.
- Las migraciones corren antes de cambiar las apps; si fallan, no se toca nada y se mantiene la versión anterior.
- Volver atrás es desplegar el hash anterior en el entorno que corresponda.

## Servicios

| Servicio | Qué hace | Imagen |
|---|---|---|
| `caddy` | HTTPS, enruta por dominio. Único con puertos publicados | `caddy:2-alpine` |
| `bot` | Webhook de WhatsApp, extracción con OpenAI, lógica de pedidos. Expone `/api/internal/*` solo a la red interna | `dispatch-bot` |
| `portal` | Tablero del despachador (Next.js) con login | `dispatch-portal` |
| `worker` | Cada 5 s llama a `/api/internal/tick`: asigna pendientes y notifica. Reemplaza el polling del portal | `dispatch-worker` |
| `postgres` | Base de datos, volumen `pgdata` | `postgres:17-alpine` |
| `migrate` | Solo al desplegar: aplica las migraciones y termina | `dispatch-migrate` |
| `engine` | Algoritmo de asignación (`POST /evaluar`), sin estado y sin base de datos. Sin puerto público. Ver `ALGORITMO.md` | `dispatch-engine` |

Todas las imágenes propias son `ghcr.io/clapi-labs/dispatch-*:<hash del commit>` (públicas). Nunca se despliega `latest`. Los contenedores tienen `restart: unless-stopped`, healthchecks y límite de memoria.

## Cómo funciona por dentro

Vistas de cerca de las piezas importantes. Sirven para entender el sistema y para saber dónde mirar cuando algo falla.

### Caddy: la puerta de entrada

Es el único contenedor con puertos abiertos. Decide a dónde va cada petición según el dominio y la ruta, y pone HTTPS (pide y renueva los certificados solo).

```mermaid
flowchart LR
    I[Internet] -- ":80 / :443" --> C{Caddy<br/>¿qué dominio?}
    C -- "staging.dispatch…" --> P[portal :3002]
    C -- "bot.staging.dispatch…" --> R{¿qué ruta?}
    R -- "/api/webhook/whatsapp<br/>/api/health" --> B[bot :3001]
    R -- "cualquier otra,<br/>incluida /api/internal/*" --> X[404 No encontrado]
    C -. "puerto 80" .-> H[redirige a HTTPS]
```

- A todas las respuestas les añade cabeceras de seguridad (HSTS, `nosniff`, sin `Server`). Al portal, además, `X-Frame-Options: DENY`.
- El portal y el bot no publican puertos: solo Caddy los alcanza por la red interna de Docker.
- La configuración es `deploy/caddy/Caddyfile` y viaja con cada despliegue.

### La API del bot

| Ruta | Quién la llama | Protección | Qué hace |
|---|---|---|---|
| `GET /api/webhook/whatsapp` | Meta, al configurar el webhook | `WHATSAPP_VERIFY_TOKEN` | Responde el reto de verificación |
| `POST /api/webhook/whatsapp` | Meta, con cada mensaje | Firma `x-hub-signature-256` con `WHATSAPP_APP_SECRET` | Recibe mensajes y botones |
| `GET /api/health` | Cualquiera | Ninguna (no expone datos) | Dice si faltan variables y si el bot está activo |
| `POST /api/internal/tick` | worker, cada 5 s | `x-internal-secret` + no expuesta | Asigna moto a los viajes pendientes y avisa |
| `POST /api/internal/notify` | portal | `x-internal-secret` + no expuesta | Avisa por WhatsApp cuando el portal asigna o marca entregado |
| `POST /api/internal/send` | portal | `x-internal-secret` + no expuesta | Un operador escribe en un chat; el bot se pausa en ese chat |

```mermaid
flowchart TB
    META[Meta] -- webhook --> W["/api/webhook/whatsapp"]
    WK[worker] -- cada 5 s --> T["/api/internal/tick"]
    PO[portal] --> N["/api/internal/notify"]
    PO --> S["/api/internal/send"]

    subgraph BOT[bot]
        W --> IN[intake: decide qué hacer]
        IN --> AI[OpenAI: extrae los datos del pedido]
        IN --> Q[cola de asignación]
        T --> Q
        N --> NT[notify: arma los mensajes]
        Q --> NT
        S --> WA[cliente de WhatsApp]
        NT --> WA
        IN --> WA
    end

    IN --> DB[(Postgres)]
    Q --> DB
    WA -- "envía, solo si BOT_ACTIVE=true" --> META
```

### Qué pasa cuando llega un mensaje

```mermaid
sequenceDiagram
    participant M as Meta
    participant B as bot
    participant DB as Postgres
    participant AI as OpenAI

    M->>B: POST /api/webhook/whatsapp
    B->>B: verifica la firma (si falla: 403)
    B-->>M: 200 OK de inmediato
    Note over B: lo demás corre después de responder,<br/>así Meta no reintenta
    B->>DB: ¿ya procesé este mensaje? (processed_messages)
    alt repetido
        B->>B: se ignora
    else nuevo
        B->>DB: guarda el mensaje en la conversación
        alt el teléfono es de un motorizado
            B->>DB: botón «Entregado»: cierra el viaje y libera la moto
            B->>M: avisa al restaurante (y asigna un pendiente si lo hay)
        else chat pausado por un operador
            B->>B: no responde
        else restaurante
            B->>AI: extrae dirección, teléfono, valor, pago
            AI-->>B: campos encontrados
            alt pedido completo
                B->>DB: crea el viaje, calcula tarifa por zona, asigna moto
                B->>M: ficha al motorizado y confirmación al restaurante
            else faltan datos
                B->>M: «Solo me falta…»
            else confuso o 3 intentos sin datos nuevos
                B->>DB: pausa el chat y lo escala a un operador
            end
        end
    end
```

Dos reglas que explican mucho del comportamiento:
- **Siempre responde 200 a Meta**, aunque algo falle por dentro. Un error solo haría que Meta reenvíe el mismo mensaje.
- **Cada mensaje se procesa una sola vez**, aunque Meta lo mande repetido (tabla `processed_messages`).

### Vida de un viaje y el worker

```mermaid
stateDiagram-v2
    [*] --> pending: pedido completo, sin moto libre
    [*] --> en_route: pedido completo, hay moto libre
    pending --> en_route: el worker (cada 5 s) o una moto que se libera
    en_route --> delivered: botón «Entregado» del motorizado o el portal
    delivered --> [*]
```

- El paso a `en_route` y a `delivered` es un `UPDATE` condicional (solo si el estado es el esperado). Por eso dos procesos a la vez nunca asignan el mismo viaje ni lo cierran dos veces.
- El **worker** no tiene lógica: solo llama a `/api/internal/tick` cada 5 s, con espera creciente si el bot falla. Así los pendientes se asignan aunque nadie tenga el portal abierto.
- Hoy la moto se elige con la cola simple de `packages/shared/src/db/dispatch-queue.ts`. El motor de `ALGORITMO.md` la reemplazará en ese mismo punto.

## Decisiones

### Hosting
- **Un VPS de Hetzner, fuera de Vercel.** El receptor de GPS necesita un proceso siempre encendido, y los pendientes no pueden depender de una pestaña abierta del portal.
- **CX23** (2 vCPU, 4 GB, ~6,49 €/mes). Suficiente sin OSRM. Se sube de plan sin reinstalar.
- **Región `nbg1` (Núremberg).** El CX23 solo existe en Europa; en Ashburn solo hay CPX, más caros. La latencia no importa: cada mensaje espera a Meta y OpenAI.
- **Dominios** (DNS en GoDaddy, registros A a la IP del servidor):

  | Entorno | Portal | Bot |
  |---|---|---|
  | Staging | `staging.dispatch.clapi.solutions` | `bot.staging.dispatch.clapi.solutions` |
  | Prod (futuro) | `dispatch.clapi.solutions` | `bot.dispatch.clapi.solutions` |

- **Node 22.23.4** y **Next 16.4.2** fijados (`.nvmrc`, `Dockerfile`).

### Entornos
- **Staging y producción son servidores separados.** Cada uno con su Postgres, su `.env`, su número de WhatsApp y su estado de OpenTofu (`infra/staging`, `infra/prod`). Un error o una prueba en staging no puede afectar a producción.
- Staging usa un número de prueba de Meta, nunca el del cliente.
- Producción se crea copiando `infra/staging`; ver `OPERACION.md`.

### Infraestructura como código (`infra/`)
- **OpenTofu** con el proveedor `hetznercloud/hcloud` (OpenTofu y no Terraform: misma sintaxis, licencia abierta).
- `infra/modules/server`: servidor, firewall, IP fija, llave de despliegue y `cloud-init`. `infra/staging`: los valores de ese entorno; prod será otra carpeta con su propio estado.
- **`cloud-init`** deja el servidor listo al primer arranque: un usuario por administrador, SSH endurecido, Docker, fail2ban, swap y límites de logs de Docker.
- `ignore_changes` en `user_data`, imagen y llaves: cambiar esos datos en el código nunca recrea el servidor.
- **La infraestructura la toca una sola persona**: el token de Hetzner y `terraform.tfstate` viven en su equipo (el estado no se sube al repo). El resto del equipo cambia el repo y entra por SSH.

### Seguridad de red y acceso
- **Firewall de Hetzner**, no `ufw`: Docker escribe sus propias reglas y se salta `ufw`. Solo 22, 80 y 443.
- SSH solo con llave, un usuario por persona (`infra/access/admins.json`), sin `root` ni contraseña, grupo `dispatch-admins`.
- **Llave de despliegue restringida**: la cuenta `deploy` solo puede ejecutar `/opt/dispatch/deploy.sh` (`command="..."` en `authorized_keys`), que a su vez solo acepta `deploy <sha>`. `deploy.sh` pertenece a root: esa cuenta no puede modificarlo.
- En Caddy, el bot expone solo `/api/webhook/whatsapp` y `/api/health`. `/api/internal/*` queda dentro de la red de Docker.
- Webhook de WhatsApp con verificación de firma. Portal con login (scrypt, cookie firmada de 12 h, 5 intentos por correo e IP).
- Cabeceras de seguridad en Caddy (HSTS, nosniff, referrer, sin `Server`).

### Secretos
- Viven **solo** en `/opt/dispatch/.env` del servidor (dueño `deploy`, grupo `docker`, permisos 660). No hay gestor externo.
- Se cambian con `set-secret.sh`, que pide el valor oculto: no queda en el historial ni en el chat.
- Las apps leen las variables al arrancar: tras cambiar un secreto hay que **redesplegar**.
- El token de Hetzner y la llave privada de despliegue están solo en el equipo del administrador.
- Nada de esto va al repo. Si un secreto se filtra, se rota; borrarlo del historial no basta.

| Variable | Para qué |
|---|---|
| `POSTGRES_PASSWORD` | Contraseña de la base |
| `INTERNAL_SECRET` | Autentica las llamadas internas (`x-internal-secret`) |
| `SESSION_SECRET` | Firma las sesiones del portal (cambiarlo las cierra todas) |
| `WHATSAPP_PHONE_NUMBER_ID`, `WHATSAPP_ACCESS_TOKEN`, `WHATSAPP_APP_SECRET`, `WHATSAPP_VERIFY_TOKEN` | WhatsApp Cloud API |
| `OPENAI_API_KEY` | Extracción de pedidos |
| `GOOGLE_MAPS_API_KEY` | Ubicar la dirección de entrega (Geocoding API). Opcional: sin ella, los viajes salen sin coordenadas |
| `BOT_ACTIVE` | `true` para que el bot responda |
| `PORTAL_HOST`, `BOT_HOST`, `ACME_EMAIL`, `REGISTRY` | Dominios, correo de Let's Encrypt, registro de imágenes |

### Despliegue
- **Por hash de commit**: `deploy.sh deploy <sha>` descarga el `compose.yml` y el `Caddyfile` de *ese* commit, baja las imágenes, aplica migraciones **antes** de tocar las apps (si fallan, no cambia nada), arranca con `up --wait` y, si algo no queda sano, vuelve solo a la versión anterior.
- Un solo despliegue a la vez (`flock`). La versión activa queda en `/opt/dispatch/.tag`.
- Volver atrás es desplegar el hash anterior.
- Staging usa este despliegue simple (las apps se recrean en segundos). El azul/verde sin corte queda para prod.
- Las migraciones deben ser compatibles con la versión anterior de la app (cambios en dos pasos), porque corren antes del cambio.

### CI/CD

```mermaid
flowchart LR
    PR[Pull request a main] --> CI["ci.yml: lint, tipos, build, migraciones, deriva del esquema"]
    PUSH[Push a dev o main] --> IMG["images.yml: construye y publica en GHCR con el hash"]
    IMG --> GHCR[(GHCR)]
    MANUAL["deploy.sh deploy hash, por SSH"] --> GHCR
    IMG -. "pendiente: deploy-staging.yml" .-> MANUAL
```

| Workflow | Cuándo corre | Qué hace |
|---|---|---|
| `ci.yml` | PR hacia `main` y push a `main` | Lint, typecheck, build, migraciones sobre base vacía aplicadas dos veces, comprueba que `schema.ts` no tenga cambios sin migración y corre el seed. Además, los casos y las pruebas del contrato del engine |
| `images.yml` | Push a `dev` y `main`, o manual | Construye `bot`, `portal`, `migrate`, `worker`, `engine` y los publica en GHCR con el hash y el nombre de la rama |
| `deploy-staging.yml` | **No existe aún** | Pendiente: al terminar `images.yml` en `dev`, ejecutar `deploy` por SSH con la llave restringida |

La marca del portal (`NEXT_PUBLIC_*`) se incrusta al construir la imagen, desde las variables del repositorio `CLIENT_NAME`, `CLIENT_INITIALS` y `CLIENT_COLOR`. Dependabot propone actualizaciones con espera de 7 días.

Plan de prod: despliegue por botón (`workflow_dispatch`) con un hash ya probado en staging, sin reconstruir la imagen.

## Lo que falta

1. Workflow de despliegue automático a staging (requiere guardar la llave de despliegue y la huella del servidor en los secretos de GitHub).
2. Servidor de producción aparte (`infra/prod`) y despliegue azul/verde.
3. Backups: los de Hetzner (~20 % del costo del servidor) y un `pg_dump` diario fuera del servidor. Hoy **no hay ninguno**.
4. Copia de seguridad de `terraform.tfstate`; sin él OpenTofu no sabe qué recursos le pertenecen.
5. Token permanente de WhatsApp (usuario del sistema); el de pruebas dura ~24 h.
6. Motor de asignación y receptor de GPS (ver `ALGORITMO.md`).
7. Datos de ubicación: autorización por escrito (Ley 1581 de 2012) y retención definida antes de usar GPS real.

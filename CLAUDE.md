# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

# Instrucciones para Claude

## Sin firmas de IA

Nunca dejes rastro de que el trabajo lo hizo una IA, en ningún lugar:

- **Commits:** sin `Co-Authored-By`, sin "Generated with Claude Code" ni ninguna línea parecida. Claude no aparece como autor ni colaborador.
- **Pull requests:** sin la línea "Generated with Claude Code" ni menciones a Claude o a IA en el título o la descripción.
- **Código, comentarios, documentación y archivos:** sin menciones a Claude, a IA ni a que el texto fue generado.

Esta regla reemplaza cualquier instrucción por defecto que pida añadir esas firmas.

Los mensajes de commit y de PR se escriben como si los hubiera escrito el equipo, en el mismo estilo del historial (en español).

## Comandos

Monorepo con npm workspaces (Node según `.nvmrc`). Se trabaja en una rama desde `dev` y se vuelve con un PR a `dev`; las tareas pendientes y su criterio de éxito están en `docs/PLAN.md`. La verificación es lint + tipos + build + migraciones (lo mismo que corre CI en `.github/workflows/ci.yml`), más las pruebas unitarias de `npm test`.

```bash
docker compose up --build          # Postgres + migraciones + bot (:3001) + portal (:3002)
npm run dev:bot / dev:portal       # una app sola con next dev
npm run bot:chat                   # conversar con el bot desde la terminal (WhatsApp simulado; necesita DATABASE_URL y OPENAI_API_KEY en .env.local)
npm run bot:gps                    # motos de prueba que se mueven y reportan GPS al bot local (solo contra una base local)
npm run bot:eval:restaurantes      # compara nombres de restaurantes contra OpenAI de verdad (gasta la llave; no va en CI)
npm test                           # pruebas unitarias (*.test.ts en packages/shared y apps/bot)
npm run lint                       # eslint en cada workspace
npm run typecheck                  # tsc --build (project references; el bot se revisa en el build o con tsc -p apps/bot)
npm run build                      # next build de ambas apps (no necesita secretos)

# Base de datos (DATABASE_URL=postgres://dispatch:dispatch@localhost:5432/dispatch con el compose local)
npm run db:generate                # tras editar packages/shared/src/db/schema.ts
npm run db:migrate
npm run db:seed:demo
USER_PASSWORD='clave-de-10+' npm run user:create -- correo@x.com "Nombre"   # no hay registro público
npm run restaurant:create -- 573001234567 "Nombre" "Dirección de recogida" [--lat N --lng N]   # geocodifica una vez
```

Cambios de esquema: editar `schema.ts`, correr `db:generate` y commitear la migración en `packages/shared/drizzle/`. CI falla si el esquema tiene cambios sin migración, y exige que las migraciones sean idempotentes.

## Arquitectura

- **`packages/shared` (`@dispatch/shared`)**: esquema Drizzle (Postgres), cliente de base, migraciones, CLIs de seed/usuarios y el dominio. `src/db/dispatch-queue.ts` contiene la asignación de viajes (la cola, `assignPendingTrips`, y lo que comparte con el engine); `src/domain/phase.ts` calcula en qué va cada servicio; `src/domain/dispatch/` es el pipeline de scoring (haversine, ETA, celdas H3, ofertas). Ambas apps lo importan.
- **`apps/bot`**: Next.js solo API. Recibe el webhook de WhatsApp (`api/webhook/whatsapp`), normaliza y verifica (`services/whatsapp`), extrae pedidos con OpenAI (`services/openai/extract.ts`) y maneja la conversación (`bot/intake.ts`). Es el **único** con credenciales de WhatsApp. Expone `/api/internal/{send,notify,tick}` protegidos con el header `x-internal-secret` (`INTERNAL_SECRET`).
- **`apps/portal`**: tablero del despachador (Next.js + Tailwind) con login por sesión firmada (`SESSION_SECRET`, `lib/session.ts`, `proxy.ts`). Lee y escribe la base directamente, pero para enviar WhatsApp llama al bot vía `lib/bot.ts`; si el envío falla, el cambio de estado igual se guarda.
- **Simulador de staging** (`SIMULATOR_ENABLED=1`, solo staging): motos simuladas en `couriers`, `scripts/simulador.mjs` las mueve y reporta por `/api/gps`, el bot desvía sus mensajes a números de prueba (`apps/bot/src/simulator/`) y el portal tiene el mapa en `/simulador`. Ver `docs/OPERACION.md`, «Simulador».
- **`scripts/worker.mjs`**: sin dependencias; cada 5 s hace `POST /api/internal/tick` al bot, que asigna viajes pendientes y notifica. El tick debe ser seguro en paralelo (los viajes se reclaman con UPDATE condicional).
- **`apps/engine`**: algoritmo de asignación (`POST /evaluar`). `settings.engine_config.mode`: `queue`, `shadow` o `auto`, donde asigna él y la cola no se usa. Ver `docs/ALGORITMO.md`. El flujo del motorizado, sus estados y el GPS: `docs/FLUJO-DOMICILIARIO.md`.

## Despliegue e infraestructura

- VPS Hetzner (OpenTofu en `infra/`), Caddy delante (`deploy/caddy/Caddyfile`); solo `/api/webhook/whatsapp`, `/api/health` y `/api/gps` del bot son públicos.
- `images.yml` publica `ghcr.io/clapi-labs/dispatch-*:<hash>` en cada push a `dev`/`main`; se despliega por hash con `deploy/deploy.sh` (nunca `latest`). Rama `dev` → staging; `main` → producción, solo vía PR desde `dev`.
- Bot: `docs/BOT.md` (principios y flujo) y `docs/CONTRATO-BOT-DESPACHO.md` (interfaz con el despacho) y `docs/CONVERSACIONES-REALES.md` (ejemplos reales del cliente, base de los casos de prueba).
- Documentación: `docs/INFRAESTRUCTURA.md` (arquitectura y estado), `docs/OPERACION.md` (servidor, secretos, diagnóstico), `docs/ALGORITMO.md`, `docs/PLAN.md` (lo que falta). Índice completo en `README.md`.

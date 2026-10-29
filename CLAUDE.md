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

Monorepo con npm workspaces (Node según `.nvmrc`). No hay suite de tests; la verificación es lint + tipos + build + migraciones (lo mismo que corre CI en `.github/workflows/ci.yml`).

```bash
docker compose up --build          # Postgres + migraciones + bot (:3001) + portal (:3002)
npm run dev:bot / dev:portal       # una app sola con next dev
npm run bot:chat                   # conversar con el bot desde la terminal (WhatsApp simulado; necesita DATABASE_URL y OPENAI_API_KEY en .env.local)
npm run lint                       # eslint en cada workspace
npm run typecheck                  # tsc --build (project references)
npm run build                      # next build de ambas apps (no necesita secretos)

# Base de datos (DATABASE_URL=postgres://dispatch:dispatch@localhost:5432/dispatch con el compose local)
npm run db:generate                # tras editar packages/shared/src/db/schema.ts
npm run db:migrate
npm run db:seed:demo
USER_PASSWORD='clave-de-10+' npm run user:create -- correo@x.com "Nombre"   # no hay registro público
```

Cambios de esquema: editar `schema.ts`, correr `db:generate` y commitear la migración en `packages/shared/drizzle/`. CI falla si el esquema tiene cambios sin migración, y exige que las migraciones sean idempotentes.

## Arquitectura

- **`packages/shared` (`@dispatch/shared`)**: esquema Drizzle (Postgres), cliente de base, migraciones, CLIs de seed/usuarios y el dominio. `src/db/dispatch-queue.ts` contiene la asignación actual de viajes (`assignPendingTrips`); `src/domain/dispatch/` es el pipeline de scoring (haversine, ETA, celdas H3, ofertas). Ambas apps lo importan.
- **`apps/bot`**: Next.js solo API. Recibe el webhook de WhatsApp (`api/webhook/whatsapp`), normaliza y verifica (`services/whatsapp`), extrae pedidos con OpenAI (`services/openai/extract.ts`) y maneja la conversación (`bot/intake.ts`). Es el **único** con credenciales de WhatsApp. Expone `/api/internal/{send,notify,tick}` protegidos con el header `x-internal-secret` (`INTERNAL_SECRET`).
- **`apps/portal`**: tablero del despachador (Next.js + Tailwind) con login por sesión firmada (`SESSION_SECRET`, `lib/session.ts`, `proxy.ts`). Lee y escribe la base directamente, pero para enviar WhatsApp llama al bot vía `lib/bot.ts`; si el envío falla, el cambio de estado igual se guarda.
- **`scripts/worker.mjs`**: sin dependencias; cada 5 s hace `POST /api/internal/tick` al bot, que asigna viajes pendientes y notifica. El tick debe ser seguro en paralelo (los viajes se reclaman con UPDATE condicional).
- **Pendiente**: servicio `engine` (algoritmo de asignación externo, `POST /evaluar`, modos `ASSIGNMENT_MODE = queue|shadow|auto` en la tabla `settings`). Ver `docs/ALGORITMO.md`.

## Despliegue e infraestructura

- VPS Hetzner (OpenTofu en `infra/`), Caddy delante (`deploy/caddy/Caddyfile`); solo `/api/webhook/whatsapp` y `/api/health` del bot son públicos.
- `images.yml` publica `ghcr.io/clapi-labs/dispatch-*:<hash>` en cada push a `dev`/`main`; se despliega por hash con `deploy/deploy.sh` (nunca `latest`). Rama `dev` → staging; `main` → producción, solo vía PR desde `dev`.
- Bot: `docs/BOT.md` (principios y flujo) y `docs/CONTRATO-BOT-DESPACHO.md` (interfaz con el despacho) y `docs/CONVERSACIONES-REALES.md` (ejemplos reales del cliente, base de los casos de prueba).
- Documentación: `docs/INFRAESTRUCTURA.md` (arquitectura y estado), `docs/OPERACION.md` (servidor, secretos, diagnóstico), `docs/ALGORITMO.md`.

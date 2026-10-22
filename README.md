# Clapi Dispatch

MVP de CLAPI Dispatch: automatización de domicilios para una agencia de logística B2B (fork de arquitectura desde `demo-delivery-system`, el sistema B2C de CLAPI).

Ver [`docs/INFRAESTRUCTURA.md`](docs/INFRAESTRUCTURA.md) para la arquitectura objetivo (VPS en Hetzner) y las decisiones de infraestructura.

## Correr en local

```bash
cp .env.example .env     # llenar solo lo que se necesite probar
docker compose up --build
```

Levanta Postgres, aplica las migraciones y sirve el bot en `http://localhost:3001` y el portal en `http://localhost:3002`. Datos de demo (con `DATABASE_URL` apuntando a la base local):

```bash
DATABASE_URL=postgres://dispatch:dispatch@localhost:5432/dispatch npm run db:seed:demo
```

Cambios de esquema: editar `packages/shared/src/db/schema.ts`, correr `npm run db:generate` y commitear la migración nueva en `packages/shared/drizzle/`. Se aplican con `npm run db:migrate` (en Docker corre solo antes de las apps).

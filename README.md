# Clapi Dispatch

Automatización de domicilios para una agencia de logística B2B: los restaurantes piden la moto por WhatsApp, el bot cotiza y arma el pedido, el algoritmo elige al domiciliario y la central sigue todo desde el portal.

## Cómo se trabaja

- La rama `dev` es la base: cada tarea sale de `dev` en su propia rama y vuelve con un PR a `dev`. `main` es producción y solo recibe PR desde `dev`.
- Lo que hay por hacer, con el criterio de éxito de cada tarea: [`docs/PLAN.md`](docs/PLAN.md).
- Antes de un PR: `npm run lint`, `npm run typecheck`, `npm test` y `npm run build`.
- Push a `dev` construye las imágenes; staging se despliega por hash ([`docs/OPERACION.md`](docs/OPERACION.md)).
- Commits y PR en español. Secretos solo en el `.env` del servidor. El repositorio es público: nada de números reales ni datos de clientes.

## Documentación

| Documento | Qué tiene |
|---|---|
| [`docs/PLAN.md`](docs/PLAN.md) | Objetivos, tareas y decisiones pendientes |
| [`docs/BOT.md`](docs/BOT.md) | La conversación con restaurantes y motorizados: flujo, reglas y decisiones |
| [`docs/FLUJO-DOMICILIARIO.md`](docs/FLUJO-DOMICILIARIO.md) | Mensajes al domiciliario, estados del servicio, recordatorios y GPS |
| [`docs/DIRECCIONES-Y-ZONAS.md`](docs/DIRECCIONES-Y-ZONAS.md) | Cómo se ubican las direcciones, las zonas de servicio y los barrios del mapa |
| [`docs/ALGORITMO.md`](docs/ALGORITMO.md) | El engine de asignación: contrato, modos y pruebas |
| [`docs/CONTRATO-BOT-DESPACHO.md`](docs/CONTRATO-BOT-DESPACHO.md) | Qué hace el bot y qué hace el despacho |
| [`docs/INTERVENCION-MANUAL.md`](docs/INTERVENCION-MANUAL.md) | Qué hace la central cuando algo sale mal |
| [`docs/CONVERSACIONES-REALES.md`](docs/CONVERSACIONES-REALES.md) | Conversaciones reales del cliente, base de los casos de prueba |
| [`docs/INFRAESTRUCTURA.md`](docs/INFRAESTRUCTURA.md) | Arquitectura, entornos y decisiones de infraestructura |
| [`docs/OPERACION.md`](docs/OPERACION.md) | Servidor: desplegar, secretos, usuarios, simulador y diagnóstico |
| [`docs/ACCESO-SERVIDOR.md`](docs/ACCESO-SERVIDOR.md) | Pedir acceso SSH al servidor de staging |

Comandos y arquitectura del código, en corto: [`CLAUDE.md`](CLAUDE.md).

## Correr en local

```bash
cp .env.example .env     # llenar solo lo que se necesite probar
docker compose up --build
```

Levanta Postgres, aplica las migraciones y sirve el bot en `http://localhost:3001` y el portal en `http://localhost:3002`. Datos de demo (con `DATABASE_URL` apuntando a la base local):

```bash
DATABASE_URL=postgres://dispatch:dispatch@localhost:5432/dispatch npm run db:seed:demo
```

Para conversar con el bot desde la terminal, sin WhatsApp: `npm run bot:chat` (necesita `DATABASE_URL` y `OPENAI_API_KEY` en `.env.local`). Los mensajes se escriben tal cual; `/ubicacion`, `/boton`, `/imagen` y `/espera` simulan lo demás.

Cambios de esquema: editar `packages/shared/src/db/schema.ts`, correr `npm run db:generate` y commitear la migración nueva en `packages/shared/drizzle/`. Se aplican con `npm run db:migrate` (en Docker corre solo antes de las apps).

## Usuarios del portal

El portal exige login. No hay registro público: los usuarios se crean desde la terminal (la contraseña va por variable para que no quede en el historial; mínimo 10 caracteres). Con el compose local levantado:

```bash
DATABASE_URL=postgres://dispatch:dispatch@localhost:5432/dispatch \
USER_PASSWORD='una-clave-larga' npm run user:create -- ana@agencia.com "Ana"
```

Repetir el comando con el mismo correo cambia su contraseña. `SESSION_SECRET` (mínimo 32 caracteres) firma las sesiones; cambiarlo las cierra todas. Cada sesión queda en la base y se puede cerrar sola desde el portal (**Alertas al celular** › **Sesiones abiertas**).

# Una sola Dockerfile para las dos apps Next.js del monorepo.
#   docker build --build-arg APP=bot    -t dispatch-bot .
#   docker build --build-arg APP=portal -t dispatch-portal .

# Versión exacta de Node (parchada el 21 de oct. de 2026). Mantener igual a .nvmrc.
ARG NODE_VERSION=22.23.4

# --- Dependencias: solo se reconstruye si cambian los package.json ---
FROM node:${NODE_VERSION}-alpine AS deps
WORKDIR /repo
COPY package.json package-lock.json ./
COPY apps/bot/package.json apps/bot/
COPY apps/portal/package.json apps/portal/
COPY packages/shared/package.json packages/shared/
RUN npm ci

# --- Build ---
FROM node:${NODE_VERSION}-alpine AS build
ARG APP
WORKDIR /repo
ENV NEXT_TELEMETRY_DISABLED=1
# Marca del cliente: NEXT_PUBLIC_* se incrusta al compilar, no al arrancar.
ARG NEXT_PUBLIC_CLIENT_NAME
ARG NEXT_PUBLIC_CLIENT_INITIALS
ARG NEXT_PUBLIC_CLIENT_COLOR
COPY --from=deps /repo/node_modules ./node_modules
COPY . .
RUN npm run build --workspace=@dispatch/${APP}

# --- Migraciones (y seed): se corre una vez por despliegue, antes de las apps ---
FROM build AS migrate
CMD ["npm", "run", "db:migrate", "--workspace=@dispatch/shared"]

# --- Worker: tareas periódicas, llama al bot (sin dependencias) ---
FROM node:${NODE_VERSION}-alpine AS worker
ENV NODE_ENV=production
WORKDIR /app
COPY scripts/worker.mjs ./scripts/worker.mjs
USER node
CMD ["node", "scripts/worker.mjs"]

# --- Imagen final: solo lo que necesita para correr ---
FROM node:${NODE_VERSION}-alpine AS runtime
ARG APP
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    HOSTNAME=0.0.0.0 \
    APP=${APP}
WORKDIR /app
RUN addgroup -S app && adduser -S app -G app
COPY --from=build --chown=app:app /repo/apps/${APP}/.next/standalone ./
COPY --from=build --chown=app:app /repo/apps/${APP}/.next/static ./apps/${APP}/.next/static
# Archivos estáticos (el mapa de zonas del portal). El bot tiene la carpeta vacía.
COPY --from=build --chown=app:app /repo/apps/${APP}/public ./apps/${APP}/public
USER app
# El puerto lo fija docker-compose (PORT); 3001 bot, 3002 portal.
CMD ["sh", "-c", "exec node apps/${APP}/server.js"]

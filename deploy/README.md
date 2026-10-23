# Despliegue en el servidor

Lo que hay en esta carpeta corre en el VPS, en `/opt/dispatch`:

| Archivo | Para qué |
|---|---|
| `deploy.sh` | Lo ejecuta GitHub Actions (o una persona) para desplegar un commit |
| `compose.yml` | Caddy, Postgres, bot, portal y worker. `deploy.sh` lo descarga del commit que despliega |
| `caddy/Caddyfile` | HTTPS y rutas. Solo se exponen el webhook y la salud del bot |
| `env.example` | Plantilla del `.env` del servidor (sin valores reales) |

## Primera vez en un servidor nuevo

Ya con el servidor creado por `infra/` y los registros DNS apuntando a su IP:

```bash
# 1. Copiar deploy.sh y la plantilla (cualquier administrador)
scp deploy/deploy.sh deploy/env.example TU_USUARIO@IP:/opt/dispatch/
# 2. En el servidor: crear el .env con permisos estrictos y llenarlo
ssh TU_USUARIO@IP
cd /opt/dispatch && mv env.example .env && sudo chown deploy:docker .env && chmod 660 .env
openssl rand -base64 36   # una vez por cada secreto (POSTGRES_PASSWORD, INTERNAL_SECRET, SESSION_SECRET)
nano .env
# 3. Primer despliegue (el sha de un commit cuyas imágenes ya estén publicadas)
./deploy.sh deploy <sha-de-40-caracteres>
```

`deploy.sh` no se actualiza solo: si cambia en el repo, hay que copiarlo de nuevo. Pertenece a **root** (es lo único que la llave de despliegue puede ejecutar, y esa cuenta no debe poder modificarlo):

```bash
scp deploy/deploy.sh TU_USUARIO@IP:/opt/dispatch/deploy.sh.new
ssh TU_USUARIO@IP 'cd /opt/dispatch && sudo install -o root -g docker -m 755 deploy.sh.new deploy.sh && rm deploy.sh.new'
```

## Cambiar un secreto

Editar `/opt/dispatch/.env` y volver a desplegar el mismo commit (los contenedores leen las variables al arrancar).

# Despliegue en el servidor

Lo que hay en esta carpeta corre en el VPS, en `/opt/dispatch`:

| Archivo | Para qué |
|---|---|
| `deploy.sh` | Lo ejecuta GitHub Actions (o una persona) para desplegar un commit |
| `compose.yml` | Caddy, Postgres, bot, portal y worker. `deploy.sh` lo descarga del commit que despliega |
| `caddy/Caddyfile` | HTTPS y rutas. Solo se exponen el webhook y la salud del bot |
| `env.example` | Plantilla del `.env` del servidor (sin valores reales) |
| `backup-db.sh` | Respaldo nocturno de la base (`pg_dump`), ver «Respaldo de la base» |

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

## Respaldo de la base

`backup-db.sh` saca un `pg_dump -Fc` del Postgres del compose a `/opt/dispatch/backups/db/` y borra los de más de `BACKUP_KEEP_DAYS` días (7 por defecto). Se instala una vez, como `deploy.sh`, y lo corre el cron cada noche:

```bash
scp deploy/backup-db.sh TU_USUARIO@IP:/opt/dispatch/backup-db.sh.new
ssh TU_USUARIO@IP 'cd /opt/dispatch && sudo install -o root -g docker -m 755 backup-db.sh.new backup-db.sh && rm backup-db.sh.new'
# 3:30 a. m. de Colombia (8:30 UTC), con la salida en el log del sistema
ssh TU_USUARIO@IP "echo '30 8 * * * root /opt/dispatch/backup-db.sh 2>&1 | logger -t dispatch-backup' | sudo tee /etc/cron.d/dispatch-backup"
```

Restaurar (reemplaza la base entera; antes, detener `bot`, `portal` y `worker`):

```bash
cd /opt/dispatch
IMAGE_TAG=$(cat .tag) docker compose --env-file .env -f compose.yml exec -T postgres \
  pg_restore -U dispatch -d dispatch --clean --if-exists < backups/db/dispatch-AAAAMMDD-HHMMSS.dump
```

Estos respaldos viven en el mismo disco: sirven ante un borrado o una migración mala, no si se pierde el servidor. Para eso, en producción se activan los backups de Hetzner (`backups = true` en el `main.tf` del entorno; staging los tiene apagados) o se copia la carpeta a otro lado. Ocupan espacio del mismo disco que vigila «Salud del sistema» (`/salud`).

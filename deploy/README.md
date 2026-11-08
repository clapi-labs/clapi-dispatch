# Despliegue en el servidor

Lo que hay en esta carpeta corre en el VPS, en `/opt/dispatch`:

| Archivo | Para qué |
|---|---|
| `deploy.sh` | Lo ejecuta GitHub Actions (o una persona) para desplegar un commit |
| `compose.yml` | Caddy, Postgres, bot, portal, worker, engine y simulador. `deploy.sh` lo descarga del commit que despliega (con la deploy key si el repositorio es privado) |
| `caddy/Caddyfile` | HTTPS y rutas. Del bot solo se exponen el webhook, la salud y el GPS |
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

## Deploy key: bajar archivos del repositorio privado

`deploy.sh` baja `compose.yml` y el `Caddyfile` del commit que despliega. Con el repositorio público los baja sin credenciales; privado, necesita una **deploy key**: una llave SSH de solo lectura que solo abre este repositorio y no vence. Si existe `/opt/dispatch/github-deploy-key`, `deploy.sh` la usa; si no, intenta sin credenciales (y falla con el repositorio privado).

Una vez por servidor, cada uno con su propia llave:

```bash
# 1. En el servidor: crear la llave (sin frase: la usa un script)
cd /opt/dispatch
sudo ssh-keygen -t ed25519 -N "" -C "deploy-$(hostname)" -f github-deploy-key
sudo chown root:docker github-deploy-key github-deploy-key.pub
sudo chmod 640 github-deploy-key
cat github-deploy-key.pub
```

2. En GitHub: repositorio → Settings → Deploy keys → Add deploy key. Título con el servidor (por ejemplo `staging`), la línea de `github-deploy-key.pub` y **sin** marcar «Allow write access».
3. Comprobar con un despliegue del hash actual: `./deploy.sh deploy "$(cat .tag)"`.

La llave privada no sale del servidor. Dueño root, grupo docker y permisos 640: la leen `deploy` y los administradores, y nadie la puede cambiar sin `sudo`. Si se filtra, se borra en GitHub (Deploy keys) y se crea otra. La huella de GitHub va fija en `deploy.sh` (`GITHUB_HOST_KEY`, publicada en `https://api.github.com/meta`); si GitHub la cambia, hay que actualizarla ahí.

## Cambiar un secreto

Editar `/opt/dispatch/.env` y volver a desplegar el mismo commit (los contenedores leen las variables al arrancar).

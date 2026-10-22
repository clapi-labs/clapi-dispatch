#!/usr/bin/env bash
# Despliegue. Lo ejecuta GitHub Actions por SSH con una llave restringida
# (command="/opt/dispatch/deploy.sh"): lo único que llega es el comando
# original en SSH_ORIGINAL_COMMAND, y solo se acepta:
#
#     deploy <sha de 40 caracteres hexadecimales>
#
# También se puede correr a mano:  ./deploy.sh deploy <sha>
#
# Qué hace: baja el compose y el Caddyfile de ESE commit, aplica las
# migraciones, cambia las apps y espera a que estén sanas. Si algo falla,
# vuelve a la versión anterior.
set -euo pipefail

DIR="${DEPLOY_DIR:-/opt/dispatch}"
REPO="${DEPLOY_REPO:-clapi-labs/clapi-dispatch}"
REQUEST="${SSH_ORIGINAL_COMMAND:-$*}"

read -r ACTION TAG EXTRA <<< "$REQUEST"
if [ "${ACTION:-}" != "deploy" ] || [[ ! "${TAG:-}" =~ ^[0-9a-f]{40}$ ]] || [ -n "${EXTRA:-}" ]; then
  echo "Uso: deploy <sha de 40 caracteres hexadecimales>" >&2
  exit 2
fi

cd "$DIR"
[ -f .env ] || { echo "Falta $DIR/.env (ver env.example)." >&2; exit 1; }

# Un solo despliegue a la vez.
exec 9> .deploy.lock
flock -n 9 || { echo "Ya hay un despliegue en curso." >&2; exit 1; }

compose() { # compose <tag> <args...>
  local tag="$1"; shift
  IMAGE_TAG="$tag" docker compose --env-file .env -f compose.yml "$@"
}
env_value() { grep -E "^$1=" .env | head -n1 | cut -d= -f2- || true; }

PREVIOUS="$(cat .tag 2>/dev/null || true)"
echo "==> Desplegando ${TAG:0:12} (antes: ${PREVIOUS:0:12})"

# 1) Archivos de ESE commit, validados antes de reemplazar nada.
STAGE="$(mktemp -d)"; trap 'rm -rf "$STAGE"' EXIT
mkdir -p "$STAGE/caddy"
for file in compose.yml caddy/Caddyfile; do
  curl -fsSL --retry 3 "https://raw.githubusercontent.com/$REPO/$TAG/deploy/$file" -o "$STAGE/$file"
  [ -s "$STAGE/$file" ] || { echo "No se pudo descargar $file." >&2; exit 1; }
done
IMAGE_TAG="$TAG" docker compose --env-file .env -f "$STAGE/compose.yml" config -q

mkdir -p caddy backup
cp -f compose.yml backup/compose.yml 2>/dev/null || true
cp -f caddy/Caddyfile backup/Caddyfile 2>/dev/null || true
cp "$STAGE/compose.yml" compose.yml
cp "$STAGE/caddy/Caddyfile" caddy/Caddyfile

# 2) Imágenes nuevas.
if [ -n "$(env_value GHCR_TOKEN)" ]; then
  env_value GHCR_TOKEN | docker login ghcr.io -u "$(env_value GHCR_USER)" --password-stdin >/dev/null
fi
compose "$TAG" pull

rollback() {
  echo "!! El despliegue falló. Registros recientes:" >&2
  compose "$TAG" logs --tail=40 bot portal worker 2>&1 || true
  if [ -n "$PREVIOUS" ] && [ -f backup/compose.yml ]; then
    echo "==> Volviendo a ${PREVIOUS:0:12}" >&2
    cp backup/compose.yml compose.yml
    [ -f backup/Caddyfile ] && cp backup/Caddyfile caddy/Caddyfile
    compose "$PREVIOUS" up -d --wait --wait-timeout 180 --remove-orphans || echo "!! Tampoco arrancó la versión anterior." >&2
  fi
  exit 1
}

# 3) Base de datos y migraciones. Si fallan, las apps no se tocan.
compose "$TAG" up -d --wait postgres
if ! compose "$TAG" run --rm migrate; then
  echo "!! Las migraciones fallaron: no se cambió nada." >&2
  # Las apps siguen en la versión anterior: sus archivos también.
  [ -f backup/compose.yml ] && cp backup/compose.yml compose.yml
  [ -f backup/Caddyfile ] && cp backup/Caddyfile caddy/Caddyfile
  exit 1
fi

# 4) Cambio de versión y espera a que estén sanas.
compose "$TAG" up -d --wait --wait-timeout 180 --remove-orphans || rollback
compose "$TAG" exec -T caddy caddy reload --config /etc/caddy/Caddyfile >/dev/null 2>&1 || true

echo "$TAG" > .tag
docker image prune -af --filter "until=72h" >/dev/null 2>&1 || true
echo "==> Listo: ${TAG:0:12}"
compose "$TAG" ps

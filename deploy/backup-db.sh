#!/usr/bin/env bash
# Respaldo de la base (issue #103). Saca un pg_dump comprimido (-Fc) del
# Postgres del compose y borra los de más de BACKUP_KEEP_DAYS días.
#
#     ./backup-db.sh            # un respaldo ahora
#
# Lo corre el cron del servidor todas las noches (ver deploy/README.md,
# «Respaldo de la base»). Se restaura con:
#
#     docker compose --env-file .env -f compose.yml exec -T postgres \
#       pg_restore -U dispatch -d dispatch --clean --if-exists < backups/db/<archivo>.dump
#
# Los respaldos quedan en el mismo disco: protegen de un borrado o una
# migración mala, no de perder el servidor. Para eso están los backups de
# Hetzner (infra/, variable `backups`) o copiar la carpeta a otro lado.
set -euo pipefail
umask 077

DIR="${DEPLOY_DIR:-/opt/dispatch}"
OUT="${BACKUP_DIR:-$DIR/backups/db}"
KEEP_DAYS="${BACKUP_KEEP_DAYS:-7}"

[[ "$KEEP_DAYS" =~ ^[0-9]+$ ]] && [ "$KEEP_DAYS" -ge 1 ] || { echo "BACKUP_KEEP_DAYS tiene que ser un número de días (>= 1)." >&2; exit 2; }

cd "$DIR"
[ -f .env ] || { echo "Falta $DIR/.env." >&2; exit 1; }
mkdir -p "$OUT"

# Un solo respaldo a la vez.
exec 9> "$OUT/.backup.lock"
flock -n 9 || { echo "Ya hay un respaldo en curso." >&2; exit 1; }

STAMP="$(date -u +%Y%m%d-%H%M%S)"
FILE="$OUT/dispatch-$STAMP.dump"
TMP="$FILE.partial"
trap 'rm -f "$TMP"' EXIT

# El IMAGE_TAG no importa para exec, pero el compose lo exige.
IMAGE_TAG="$(cat .tag 2>/dev/null || echo none)" docker compose --env-file .env -f compose.yml \
  exec -T postgres pg_dump -U dispatch -d dispatch -Fc > "$TMP"
[ -s "$TMP" ] || { echo "El respaldo salió vacío." >&2; exit 1; }
mv "$TMP" "$FILE"
echo "==> Respaldo: $FILE ($(du -h "$FILE" | cut -f1))"

# Solo los nuestros, y nunca el que se acaba de crear.
find "$OUT" -maxdepth 1 -type f -name 'dispatch-*.dump' -mtime "+$((KEEP_DAYS - 1))" ! -name "$(basename "$FILE")" -print -delete \
  | sed 's/^/    borrado: /'

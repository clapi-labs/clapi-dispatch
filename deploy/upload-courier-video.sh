#!/usr/bin/env bash
# Carga (o reemplaza) el video MP4 de activación inicial para domiciliarios
# en el volumen del bot (`/data/media/onboarding/domiciliarios.mp4`) y limpia
# la caché de `media_id` en `settings` para que Meta reciba la versión nueva.
#
# Uso desde tu equipo (copiando por SSH):
#   scp video.mp4 TU_USUARIO@IP:/tmp/domiciliarios.mp4
#   ssh TU_USUARIO@IP '/opt/dispatch/upload-courier-video.sh /tmp/domiciliarios.mp4 && rm -f /tmp/domiciliarios.mp4'
#
# Requisitos de Meta WhatsApp Cloud API: MP4 (H.264 + AAC) de máximo 16 MB.
set -euo pipefail

FILE="${1:?Uso: upload-courier-video.sh /ruta/al/video.mp4}"
[ -f "$FILE" ] || { echo "No existe el archivo: $FILE" >&2; exit 1; }

SIZE="$(stat -c%s "$FILE" 2>/dev/null || stat -f%z "$FILE")"
MAX=$((16 * 1024 * 1024))
if [ "$SIZE" -eq 0 ] || [ "$SIZE" -gt "$MAX" ]; then
  echo "El video pesa ${SIZE} bytes; Meta solo acepta MP4 de hasta 16 MB (16777216 bytes)." >&2
  exit 1
fi

cd "${DEPLOY_DIR:-/opt/dispatch}"
TAG="$(cat .tag)"

docker exec dispatch-bot-1 mkdir -p /data/media/onboarding
docker cp "$FILE" dispatch-bot-1:/data/media/onboarding/domiciliarios.mp4.tmp
docker exec dispatch-bot-1 mv /data/media/onboarding/domiciliarios.mp4.tmp /data/media/onboarding/domiciliarios.mp4

# Limpiar mediaId cacheado conservando caption/url si existieran.
IMAGE_TAG="$TAG" docker compose --env-file .env -f compose.yml exec -T postgres \
  psql -U dispatch -d dispatch -c \
  "update settings set value = value - 'mediaId' - 'mediaIdUploadedAt' - 'fileHash' where key = 'courier_onboarding_video';" >/dev/null

echo "==> Video cargado ($(du -h "$FILE" | cut -f1)). El bot lo subirá a Meta automáticamente en la próxima activación."

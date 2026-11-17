#!/usr/bin/env bash
# Mide qué tan bien ubica el bot las direcciones contra Google de verdad
# (la llave solo sirve desde este servidor), con las zonas de servicio de
# esta base. No cambia nada. Ver docs/DIRECCIONES-Y-ZONAS.md, «Precisión de
# las direcciones».
#
#   /opt/dispatch/measure-addresses.sh                 # todos los casos
#   /opt/dispatch/measure-addresses.sh --extraccion    # además lee el texto con el modelo (gasta OpenAI)
#   /opt/dispatch/measure-addresses.sh --solo trampa-01,estandar-02
#
# Deja informe.md y resultados.json en /opt/dispatch/mediciones/direcciones-<fecha>/.
# Sale con 1 si hay casos graves (otro sector, otro municipio o punto inventado).
set -euo pipefail
cd "${DEPLOY_DIR:-/opt/dispatch}"
TAG="$(cat .tag)"

# El valor tal cual está en .env (con $, = o comillas), sin pasarlo por la línea de comandos.
env_value() { awk -v k="$1" 'index($0, k "=") == 1 { print substr($0, length(k) + 2) }' .env; }
GOOGLE_MAPS_API_KEY="$(env_value GOOGLE_MAPS_API_KEY)"
OPENAI_API_KEY="$(env_value OPENAI_API_KEY)"
MEDICION_SERVIDOR="$(env_value BOT_HOST) (imagen ${TAG})"
export GOOGLE_MAPS_API_KEY OPENAI_API_KEY MEDICION_SERVIDOR

OUT="mediciones/direcciones-$(TZ=America/Bogota date +%Y-%m-%d-%H%M)"
mkdir -p "$OUT"

IMAGE_TAG="$TAG" docker compose --env-file .env -f compose.yml run --rm \
  -e GOOGLE_MAPS_API_KEY -e OPENAI_API_KEY -e MEDICION_SERVIDOR -e GEOCODE_SIMULADO=false \
  -v "$PWD/$OUT:/out" migrate \
  npm run --silent direcciones:medir --workspace=@dispatch/bot -- --salida /out "$@"

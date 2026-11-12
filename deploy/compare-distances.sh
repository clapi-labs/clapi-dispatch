#!/usr/bin/env bash
# Cuánto cambia la distancia por calle (OSRM) frente a la de hoy (línea recta
# × 1,3), con los restaurantes y las zonas de este servidor. Solo números
# agregados; no cambia nada. Ver docs/OPERACION.md, «Mapa de calles (OSRM)».
#
#   /opt/dispatch/compare-distances.sh
set -euo pipefail
cd "${DEPLOY_DIR:-/opt/dispatch}"
TAG="$(cat .tag)"

IMAGE_TAG="$TAG" docker compose --env-file .env -f compose.yml run --rm -e OSRM_URL=http://osrm:5000 migrate \
  npm run calles:comparar --workspace=@dispatch/shared

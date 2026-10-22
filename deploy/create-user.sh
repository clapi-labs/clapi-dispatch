#!/usr/bin/env bash
# Crea (o cambia la contraseña de) un usuario del portal, en el servidor:
#
#   ssh -t TU_USUARIO@IP '/opt/dispatch/create-user.sh correo@dominio.com "Nombre"'
#
# La contraseña se pide por teclado (no se ve ni queda en el historial).
# Necesita una terminal interactiva (por eso el -t de ssh).
set -euo pipefail
umask 002

EMAIL="${1:?Uso: create-user.sh correo@dominio.com \"Nombre\"}"
NAME="${2:-$EMAIL}"
cd "${DEPLOY_DIR:-/opt/dispatch}"
TAG="$(cat .tag)"

if [ -z "${USER_PASSWORD:-}" ]; then
  read -rsp "Contraseña (mínimo 10 caracteres): " USER_PASSWORD; echo
  read -rsp "Repítela: " CONFIRM; echo
  [ "$USER_PASSWORD" = "$CONFIRM" ] || { echo "No coinciden." >&2; exit 1; }
fi

IMAGE_TAG="$TAG" USER_PASSWORD="$USER_PASSWORD" \
  docker compose --env-file .env -f compose.yml run --rm -e USER_PASSWORD migrate \
  npm run user:create -- "$EMAIL" "$NAME"

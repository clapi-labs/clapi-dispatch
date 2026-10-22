#!/usr/bin/env bash
# Sincroniza los administradores de un servidor con infra/access/admins.json.
# Lo puede correr cualquiera que ya tenga acceso al servidor:
#
#   infra/scripts/sync-admins.sh tu_usuario@IP
#
# Para dar acceso a alguien: agregar su línea a admins.json, commitear y correr esto.
# Para quitárselo: borrar su línea y correr esto.
set -euo pipefail

TARGET="${1:?Uso: $0 usuario@host}"
DIR="$(cd "$(dirname "$0")" && pwd)"
ADMINS_B64="$(base64 -w0 "$DIR/../access/admins.json")"

ssh "$TARGET" "sudo env ADMINS_B64='$ADMINS_B64' bash -s" < "$DIR/remote-sync-admins.sh"

#!/usr/bin/env bash
# Cambia el valor de UNA variable del .env del servidor, pidiéndolo por teclado
# (no se ve en pantalla, no queda en el historial de la terminal ni en ningún
# chat). Hay que correrlo con una terminal interactiva (ssh -t):
#
#   ssh -t TU_USUARIO@IP '/opt/dispatch/set-secret.sh OPENAI_API_KEY'
#
# Después hay que volver a desplegar para que las apps lean el valor nuevo:
#   ssh TU_USUARIO@IP 'cd /opt/dispatch && ./deploy.sh deploy $(cat .tag)'
set -euo pipefail
umask 007

KEY="${1:?Uso: set-secret.sh NOMBRE_DE_LA_VARIABLE}"
cd "${DEPLOY_DIR:-/opt/dispatch}"

[[ "$KEY" =~ ^[A-Z][A-Z0-9_]*$ ]] || { echo "Nombre de variable inválido." >&2; exit 1; }
# Solo se cambian variables que ya existen en el .env: así un error de
# tipeo no crea una variable nueva en silencio.
grep -q "^$KEY=" .env || { echo "$KEY no existe en .env." >&2; exit 1; }

read -rsp "Valor de $KEY: " VALUE; echo
[ -n "$VALUE" ] || { echo "El valor está vacío: no se cambió nada." >&2; exit 1; }

TMP="$(mktemp)"; trap 'rm -f "$TMP"' EXIT
# ENVIRON deja el valor tal cual (con $, \, &, = ...), sin escapes.
KEY="$KEY" VALUE="$VALUE" awk '
  index($0, ENVIRON["KEY"] "=") == 1 { print ENVIRON["KEY"] "=" ENVIRON["VALUE"]; next }
  { print }
' .env > "$TMP"
# Se escribe DENTRO del archivo existente: conserva dueño y permisos.
cat "$TMP" > .env
echo "Listo: $KEY actualizado (${#VALUE} caracteres)."

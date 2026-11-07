#!/usr/bin/env bash
# Abre un túnel SSH al Postgres de staging en localhost:5434 (Ctrl+C lo cierra).
#   tools/simulador-demo/tunel-staging.sh tu_usuario
set -euo pipefail
HOST="${1:?uso: $0 tu_usuario}@staging.dispatch.clapi.solutions"
SSH=(ssh -o ExitOnForwardFailure=yes -i "${SSH_KEY:-$HOME/.ssh/clapi_ed25519}")
# Postgres no publica puerto en el servidor: se apunta a la IP del contenedor.
IP=$("${SSH[@]}" "$HOST" "docker inspect -f '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}' dispatch-postgres-1")
echo "Túnel abierto: localhost:5434 → postgres de staging ($IP). Ctrl+C para cerrar."
exec "${SSH[@]}" -N -L "127.0.0.1:5434:$IP:5432" "$HOST"

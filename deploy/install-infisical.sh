#!/usr/bin/env bash
# Instala la CLI de Infisical en el servidor (como root: usar sudo). La versión
# y su SHA-256 están fijados aquí: si alguien alterara el archivo publicado, no
# coincidiría y la instalación se detiene.
#
# Para actualizar: cambiar VERSION y SHA256 con los de checksums.txt del release
#   https://github.com/Infisical/infisical/releases (etiqueta infisical-cli/vX.Y.Z)
set -euo pipefail

VERSION="0.41.90"
SHA256="ff67e4b0f5fafe1b33ea1606767e6235a8742cc47e6af634cdff54b8d1fccc0a"
FILE="infisical_${VERSION}_linux_amd64.tar.gz"

[ "$(id -u)" = 0 ] || { echo "Correr con sudo." >&2; exit 1; }

WORK="$(mktemp -d)"; trap 'rm -rf "$WORK"' EXIT
curl -fsSL --retry 3 -o "$WORK/$FILE" "https://github.com/Infisical/infisical/releases/download/infisical-cli/v${VERSION}/${FILE}"
echo "${SHA256}  $WORK/$FILE" | sha256sum -c - >/dev/null || { echo "El SHA-256 no coincide: no se instala." >&2; exit 1; }
tar -xzf "$WORK/$FILE" -C "$WORK" infisical
install -m 755 "$WORK/infisical" /usr/local/bin/infisical
infisical --version

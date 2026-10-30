#!/usr/bin/env bash
# Descarga de OpenStreetMap las vías y los barrios de Cali y Jamundí para el
# mapa de zonas. Deja los JSON crudos en la carpeta que se le pase (por
# defecto ./osm-raw) y luego: python3 empaquetar.py osm-raw cali.json
set -euo pipefail
OUT="${1:-osm-raw}"; mkdir -p "$OUT"
UA="clapi-dispatch-zonas/1.0"
SERVERS=(https://overpass.kumi.systems/api/interpreter https://overpass-api.de/api/interpreter https://overpass.private.coffee/api/interpreter)
HIGHWAYS='^(motorway|trunk|primary|secondary|tertiary|residential|unclassified|living_street)$'
PLACES='^(neighbourhood|suburb|quarter|village|hamlet)$'

fetch() { # $1 = consulta, $2 = archivo
  for srv in "${SERVERS[@]}"; do
    curl -s -m 240 -A "$UA" --data-urlencode "data=$1" "$srv" -o "$OUT/$2"
    if head -c 30 "$OUT/$2" | grep -q '{'; then echo "✓ $2 ($srv)"; return; fi
    echo "  falló $srv, probando otro…"
  done
  echo "✗ no se pudo descargar $2"; exit 1
}

for zona in "cali:3.32,-76.60,3.51,-76.45" "jamundi:3.17,-76.62,3.33,-76.45"; do
  name="${zona%%:*}"; bbox="${zona#*:}"
  suffix=$([ "$name" = cali ] && echo "" || echo "_$name")
  fetch "[out:json][timeout:220];way[\"highway\"~\"$HIGHWAYS\"]($bbox);out geom tags;" "roads$suffix.json"
  fetch "[out:json][timeout:100];node[\"place\"~\"$PLACES\"]($bbox);out tags;" "places$suffix.json"
done

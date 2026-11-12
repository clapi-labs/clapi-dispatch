# OSRM propio: distancias por calle para el precio del domicilio y los tiempos
# del engine (docs/OPERACION.md, «Mapa de calles (OSRM)»). La imagen trae el
# mapa ya procesado; al arrancar no descarga nada.
#   docker build -t dispatch-osrm apps/osrm
#
# Para actualizar el mapa se cambia MAPA_FECHA (un archivo con fecha de
# Geofabrik, AAMMDD; se usa el del día 1 de cada mes) y su MAPA_MD5, en un PR.

# Versión exacta de OSRM (oct. de 2026).
ARG OSRM_IMAGE=ghcr.io/project-osrm/osrm-backend:v26.10.0-debian
ARG MAPA_FECHA=261101
ARG MAPA_MD5=7647cea3860f75e8c187fb3ed6a0f034
# Cali, Jamundí, Yumbo, Candelaria y el borde de Palmira (oeste,sur,este,norte),
# con margen alrededor del área donde el bot ubica direcciones: una ruta cerca
# del borde puede salir y volver a entrar.
ARG AREA=-76.75,3.10,-76.25,3.70

# 1) Colombia de Geofabrik, recortada al área: el resto del país no sirve y
#    ocuparía memoria en el servidor.
FROM debian:trixie-slim AS recorte
ARG MAPA_FECHA
ARG MAPA_MD5
ARG AREA
RUN apt-get update \
 && apt-get install -y --no-install-recommends osmium-tool curl ca-certificates \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /data
RUN curl -fsSL --retry 3 -o colombia.osm.pbf "https://download.geofabrik.de/south-america/colombia-${MAPA_FECHA}.osm.pbf" \
 && echo "${MAPA_MD5}  colombia.osm.pbf" | md5sum -c - \
 && osmium extract --bbox="${AREA}" --strategy=complete_ways colombia.osm.pbf -o cali.osm.pbf \
 && rm colombia.osm.pbf

# 2) Grafo de calles con el perfil de carro (las motos siguen las mismas vías
#    y sentidos), preparado para MLD.
FROM ${OSRM_IMAGE} AS grafo
COPY --from=recorte /data/cali.osm.pbf /data/cali.osm.pbf
RUN osrm-extract -p /opt/car.lua /data/cali.osm.pbf \
 && osrm-partition /data/cali.osrm \
 && osrm-customize /data/cali.osrm \
 && rm /data/cali.osm.pbf

# 3) Solo el servidor y el grafo.
FROM ${OSRM_IMAGE}
ARG MAPA_FECHA
LABEL org.opencontainers.image.description="OSRM con el mapa de Cali de OpenStreetMap (Geofabrik ${MAPA_FECHA})"
# wget para el healthcheck del compose.
RUN apt-get update \
 && apt-get install -y --no-install-recommends wget \
 && rm -rf /var/lib/apt/lists/*
COPY --from=grafo /data /data
ENV MAPA_FECHA=${MAPA_FECHA}
USER nobody
EXPOSE 5000
# --max-table-size: el engine pide en una consulta la distancia entre todos los
# puntos de una evaluación (motos, restaurante, cliente y paradas pendientes).
CMD ["osrm-routed", "--algorithm", "mld", "--max-table-size", "500", "--port", "5000", "/data/cali.osrm"]

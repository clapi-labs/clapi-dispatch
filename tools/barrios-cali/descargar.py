"""
Baja los barrios oficiales de Cali y los deja listos para el mapa de precios
por zona del portal (docs/DIRECCIONES-Y-ZONAS.md, «Precio mínimo por zona»).

    python3 tools/barrios-cali/descargar.py apps/portal/public/zonas/barrios.json

La fuente es la capa «Barrios y sectores» (DIVIPOLA) de la IDESC, la
infraestructura de datos espaciales de la Alcaldía. Se pide al servicio WFS de
su GeoServer, que la convierte del sistema de coordenadas de Cali
(MAGNA-SIRGAS origen Cali) a latitud y longitud (EPSG:4326): así no hace falta
el shapefile ni una librería de proyecciones.

Cada barrio queda con un solo contorno, el de su parte más grande y sin
huecos, simplificado a pocos metros: es lo que la central puede volver una
zona y ajustar en el mapa. Solo usa la librería estándar de Python.
"""

import json
import math
import sys
import urllib.parse
import urllib.request
from datetime import date

WFS = "https://ws-idesc.cali.gov.co/geoserver/wfs"
LAYER = "dapm:pdt_dpa_barrios_sectores"
# Tolerancia de la simplificación: a esta escala un borde que se corre 2 m no
# cambia de cuadra. Si un barrio queda con demasiadas esquinas para editarlo
# cómodo, se sube hasta que quepa.
TOLERANCE_M = 2.0
MAX_VERTICES = 400

R = 6371000.0


def fetch():
    params = urllib.parse.urlencode(
        {
            "service": "WFS",
            "version": "2.0.0",
            "request": "GetFeature",
            "typeNames": LAYER,
            "propertyName": "barcodigo,barnombre,barcomuna,barcategor,baracusan,the_geom",
            "outputFormat": "application/json",
            "srsName": "EPSG:4326",
        }
    )
    with urllib.request.urlopen(f"{WFS}?{params}", timeout=120) as response:
        return json.load(response)


def to_xy(ring):
    """Grados a metros alrededor del primer punto: basta para un barrio."""
    lng0, lat0 = ring[0]
    k = math.cos(math.radians(lat0))
    return [((lng - lng0) * k * math.pi / 180 * R, (lat - lat0) * math.pi / 180 * R) for lng, lat in ring]


def area_m2(ring):
    pts = to_xy(ring)
    return abs(sum(x1 * y2 - x2 * y1 for (x1, y1), (x2, y2) in zip(pts, pts[1:] + pts[:1]))) / 2


def seg_dist(p, a, b):
    (px, py), (ax, ay), (bx, by) = p, a, b
    dx, dy = bx - ax, by - ay
    length = dx * dx + dy * dy
    t = max(0.0, min(1.0, ((px - ax) * dx + (py - ay) * dy) / length)) if length else 0.0
    return math.hypot(px - (ax + t * dx), py - (ay + t * dy))


def douglas_peucker(points, xy, tolerance):
    """Índices que se conservan, sin recursión (los bordes pueden ser largos)."""
    keep = {0, len(points) - 1}
    stack = [(0, len(points) - 1)]
    while stack:
        i, j = stack.pop()
        best, index = 0.0, None
        for k in range(i + 1, j):
            d = seg_dist(xy[k], xy[i], xy[j])
            if d > best:
                best, index = d, k
        if index is not None and best > tolerance:
            keep.add(index)
            stack += [(i, index), (index, j)]
    return [points[k] for k in sorted(keep)]


def simplify(ring):
    """El contorno abierto (sin repetir el primer punto), con pocas esquinas."""
    if ring[0] == ring[-1]:
        ring = ring[:-1]
    # Se cierra para simplificar y se vuelve a abrir al final.
    closed = ring + [ring[0]]
    xy = to_xy(closed)
    tolerance = TOLERANCE_M
    while True:
        out = douglas_peucker(closed, xy, tolerance)[:-1]
        if len(out) <= MAX_VERTICES or tolerance > 50:
            return out
        tolerance *= 1.5


def main():
    if len(sys.argv) != 2:
        sys.exit("Uso: python3 descargar.py <salida.json>")
    data = fetch()
    barrios, multipart, acuerdos = [], 0, set()
    for feature in data["features"]:
        p = feature["properties"]
        geometry = feature["geometry"]
        polygons = geometry["coordinates"] if geometry["type"] == "MultiPolygon" else [geometry["coordinates"]]
        if len(polygons) > 1:
            multipart += 1
        outer = max((poly[0] for poly in polygons), key=area_m2)
        ring = simplify(outer)
        if len(ring) < 3:
            continue
        if p.get("baracusan"):
            acuerdos.add(p["baracusan"])
        barrios.append(
            {
                "codigo": p["barcodigo"],
                "nombre": p["barnombre"].strip(),
                "comuna": p["barcomuna"],
                "tipo": p["barcategor"],
                # [lat, lng] con 6 decimales (unos 10 cm), como guarda el portal.
                "borde": [[round(lat, 6), round(lng, 6)] for lng, lat in ring],
            }
        )
    barrios.sort(key=lambda b: b["codigo"])
    out = {
        "fuente": f"IDESC, Alcaldía de Santiago de Cali · capa {LAYER} ({WFS})",
        "acuerdos": sorted(acuerdos),
        "descargado": date.today().isoformat(),
        "barrios": barrios,
    }
    with open(sys.argv[1], "w", encoding="utf-8") as f:
        json.dump(out, f, ensure_ascii=False, separators=(",", ":"))
    vertices = sum(len(b["borde"]) for b in barrios)
    print(f"{len(barrios)} barrios y sectores, {vertices} esquinas en total (máx. {max(len(b['borde']) for b in barrios)} en uno).")
    if multipart:
        print(f"{multipart} venían en varias partes: queda la más grande.")


if __name__ == "__main__":
    main()

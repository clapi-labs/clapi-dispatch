"""
Baja los barrios de Cali y los deja listos para el mapa de zonas del portal
(docs/DIRECCIONES-Y-ZONAS.md, «Los barrios»).

    python3 tools/barrios-cali/descargar.py apps/portal/public/zonas/barrios.json

Tres fuentes, en este orden:

1. La capa «Barrios y sectores» (DIVIPOLA) de la IDESC, la infraestructura de
   datos espaciales de la Alcaldía: los 342 barrios del perímetro urbano.
2. La capa «Sectores del suelo de expansión urbana» de la IDESC: los 20
   sectores del sur, entre Cali y Jamundí (Bochalema, Cachipay, Ciudad
   Meléndez…), que ya son ciudad pero no están en la DIVIPOLA.
3. Barrios de OpenStreetMap que la central usa y que ninguna capa oficial trae
   con su propio borde (`OSM_BARRIOS`, abajo): hoy, Ciudad Pacífica.

Las capas de la IDESC se piden al servicio WFS de su GeoServer, que las
convierte del sistema de coordenadas de Cali (MAGNA-SIRGAS origen Cali) a
latitud y longitud (EPSG:4326): así no hace falta el shapefile ni una librería
de proyecciones. Los de OpenStreetMap salen de su API (la relación completa).

Los barrios rurales (corregimientos) no se incluyen.

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
EXPANSION_LAYER = "dapm:pdt_dpa_sectores_suelo_exp_urb"
OSM_API = "https://api.openstreetmap.org/api/0.6"
USER_AGENT = "clapi-dispatch barrios-cali/1.0"

# Los sectores de expansión que vienen con nombre de plan parcial, con uno que
# se entienda.
EXPANSION_NAMES = {
    "PP1": "Plan parcial 1",
    "PP4-PP5": "Planes parciales 4 y 5",
    "PP6-PP8-PP10": "Planes parciales 6, 8 y 10",
    "Las Vegas": "Las Vegas de Comfandi",
}
# Cómo más se buscan en el mapa.
EXPANSION_ALIAS = {
    "Las Vegas": ["Las Vegas", "Vegas de Comfandi"],
}

# Barrios urbanos que la central usa y que no tienen borde propio en la IDESC:
# la relación de OpenStreetMap, el nombre y cómo más se buscan.
OSM_BARRIOS = [
    # Dentro del sector de expansión Piedrachiquita; la central le dice «Pacífico».
    {"relation": 9400002, "nombre": "Ciudad Pacífica", "alias": ["Pacífico"]},
]

# Tolerancia de la simplificación: a esta escala un borde que se corre 2 m no
# cambia de cuadra. Si un barrio queda con demasiadas esquinas para editarlo
# cómodo, se sube hasta que quepa.
TOLERANCE_M = 2.0
MAX_VERTICES = 400

R = 6371000.0


def get_json(url):
    request = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
    with urllib.request.urlopen(request, timeout=120) as response:
        return json.load(response)


def fetch(layer, properties):
    params = urllib.parse.urlencode(
        {
            "service": "WFS",
            "version": "2.0.0",
            "request": "GetFeature",
            "typeNames": layer,
            "propertyName": f"{properties},the_geom",
            "outputFormat": "application/json",
            "srsName": "EPSG:4326",
        }
    )
    return get_json(f"{WFS}?{params}")


def to_xy(ring):
    """Grados a metros alrededor del primer punto: basta para un barrio."""
    lng0, lat0 = ring[0]
    k = math.cos(math.radians(lat0))
    return [((lng - lng0) * k * math.pi / 180 * R, (lat - lat0) * math.pi / 180 * R) for lng, lat in ring]


def area_m2(ring):
    pts = to_xy(ring)
    return abs(sum(x1 * y2 - x2 * y1 for (x1, y1), (x2, y2) in zip(pts, pts[1:] + pts[:1]))) / 2


def largest_outer(geometry):
    """El contorno exterior de la parte más grande, y si venía en varias."""
    polygons = geometry["coordinates"] if geometry["type"] == "MultiPolygon" else [geometry["coordinates"]]
    return max((poly[0] for poly in polygons), key=area_m2), len(polygons) > 1


def osm_outer_ring(relation_id):
    """El borde exterior de una relación de OpenStreetMap, como [lng, lat]: une
    sus caminos exteriores por los extremos. Si quedan varios anillos, el mayor."""
    data = get_json(f"{OSM_API}/relation/{relation_id}/full.json")
    nodes = {e["id"]: (e["lon"], e["lat"]) for e in data["elements"] if e["type"] == "node"}
    ways = {e["id"]: e["nodes"] for e in data["elements"] if e["type"] == "way"}
    relation = next(e for e in data["elements"] if e["type"] == "relation" and e["id"] == relation_id)
    pending = [list(ways[m["ref"]]) for m in relation["members"] if m["type"] == "way" and m["role"] in ("outer", "")]
    rings = []
    while pending:
        ring = pending.pop(0)
        while ring[0] != ring[-1]:
            for i, way in enumerate(pending):
                if way[0] == ring[-1]:
                    ring = ring + way[1:]
                elif way[-1] == ring[-1]:
                    ring = ring + way[-2::-1]
                elif way[-1] == ring[0]:
                    ring = way[:-1] + ring
                elif way[0] == ring[0]:
                    ring = way[:0:-1] + ring
                else:
                    continue
                pending.pop(i)
                break
            else:
                sys.exit(f"La relación {relation_id} de OpenStreetMap no cierra su borde.")
        rings.append([nodes[n] for n in ring])
    return max(rings, key=area_m2)


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
    ring = [tuple(p) for p in ring]
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
    barrios, multipart, acuerdos = [], 0, set()

    def add(codigo, nombre, comuna, tipo, fuente, outer, alias=None):
        ring = simplify(outer)
        if len(ring) < 3:
            return
        barrio = {
            "codigo": codigo,
            "nombre": nombre,
            "comuna": comuna,
            "tipo": tipo,
            "fuente": fuente,
            # [lat, lng] con 6 decimales (unos 10 cm), como guarda el portal.
            "borde": [[round(lat, 6), round(lng, 6)] for lng, lat in ring],
        }
        if alias:
            barrio["alias"] = alias
        barrios.append(barrio)

    # 1. Los barrios y sectores de la DIVIPOLA.
    for feature in fetch(LAYER, "barcodigo,barnombre,barcomuna,barcategor,baracusan")["features"]:
        p = feature["properties"]
        outer, parts = largest_outer(feature["geometry"])
        multipart += parts
        if p.get("baracusan"):
            acuerdos.add(p["baracusan"])
        add(p["barcodigo"], p["barnombre"].strip(), p["barcomuna"], p["barcategor"], "idesc", outer)
    official = len(barrios)

    # 2. Los sectores del suelo de expansión urbana (no tienen comuna).
    for feature in fetch(EXPANSION_LAYER, "ssecodigo,ssenombre")["features"]:
        p = feature["properties"]
        name = p["ssenombre"].strip()
        outer, parts = largest_outer(feature["geometry"])
        multipart += parts
        add(f"EXP-{p['ssecodigo']}", EXPANSION_NAMES.get(name, name), "", "Expansión", "idesc-expansion", outer, EXPANSION_ALIAS.get(name))
    expansion = len(barrios) - official

    # 3. Los de OpenStreetMap.
    for b in OSM_BARRIOS:
        add(f"OSM-{b['relation']}", b["nombre"], "", "Barrio", "osm", osm_outer_ring(b["relation"]), b.get("alias"))

    barrios.sort(key=lambda b: b["codigo"])
    out = {
        "fuente": f"IDESC, Alcaldía de Santiago de Cali ({WFS}) y OpenStreetMap",
        "fuentes": {
            "idesc": f"IDESC · {LAYER}: barrios y sectores de la DIVIPOLA",
            "idesc-expansion": f"IDESC · {EXPANSION_LAYER}: sectores del suelo de expansión urbana",
            "osm": "© colaboradores de OpenStreetMap (ODbL): la relación es el número del código OSM-<id>",
        },
        "acuerdos": sorted(acuerdos),
        "descargado": date.today().isoformat(),
        "barrios": barrios,
    }
    with open(sys.argv[1], "w", encoding="utf-8") as f:
        json.dump(out, f, ensure_ascii=False, separators=(",", ":"))
    vertices = sum(len(b["borde"]) for b in barrios)
    print(f"{official} de la DIVIPOLA, {expansion} de expansión, {len(barrios) - official - expansion} de OpenStreetMap.")
    print(f"{len(barrios)} barrios y sectores, {vertices} esquinas en total (máx. {max(len(b['borde']) for b in barrios)} en uno).")
    if multipart:
        print(f"{multipart} venían en varias partes: queda la más grande.")


if __name__ == "__main__":
    main()

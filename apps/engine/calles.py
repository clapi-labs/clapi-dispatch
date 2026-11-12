"""Minutos de viaje con los km reales por calle del OSRM propio (docs/OPERACION.md, «Mapa de calles»).

Con `tiempos = "osrm"`, el engine pide a OSRM, en una sola consulta (/table), la distancia por calle
entre todos los puntos de la evaluación, y la pasa a minutos con la misma VELOCIDAD_KMH de siempre: así
el precio (que cobra esos mismos km) y la asignación miden igual, y la fórmula del score no cambia.

Si OSRM no responde, o un tramo no tiene ruta, ese tramo (o toda la evaluación) usa el respaldo de
siempre: línea recta × FACTOR_RUTA. La respuesta dice qué fuente se usó (`tiempos`) y la caída queda en
el registro del contenedor. Solo librería estándar.
"""

import json
import os
import sys
import threading
import time
import urllib.request

# Cuánto se espera a OSRM antes de usar el respaldo. El bot le da 3 s al engine en total.
TIMEOUT_S = 1.0
# Tras una caída, cuánto se usa el respaldo sin volver a preguntar.
REINTENTO_S = 30.0
# Un punto que OSRM tiene que mover más que esto para dejarlo en una calle está fuera del mapa cargado.
MAX_AJUSTE_M = 500.0

_estado = {"caido_hasta": 0.0, "caido": False}
_candado = threading.Lock()


def _registrar(mensaje):
    print(f"[calles] {mensaje}", file=sys.stderr, flush=True)


def _clave(punto):
    return (round(float(punto[0]), 6), round(float(punto[1]), 6))


def tabla_km(puntos, url=None, abrir=None, reloj=time.monotonic):
    """Distancias por calle (km) entre todos los puntos (lat, lon), o un motivo si no se pudo.

    Devuelve (km, motivo): km es un dict {(a, b): km} con a y b como _clave(punto); un tramo sin ruta,
    o con un punto fuera del mapa, no está. motivo es None si OSRM respondió, o por qué se usa el respaldo.
    """
    abrir = abrir or urllib.request.urlopen
    url = (url if url is not None else os.environ.get("OSRM_URL", "")).rstrip("/")
    if not url:
        return {}, "sin OSRM_URL"
    with _candado:
        if reloj() < _estado["caido_hasta"]:
            return {}, "OSRM caído hace poco; se reintenta luego"
    unicos = list(dict.fromkeys(_clave(p) for p in puntos))
    if len(unicos) < 2:
        return {}, None
    coords = ";".join(f"{lon},{lat}" for lat, lon in unicos)
    try:
        with abrir(f"{url}/table/v1/driving/{coords}?annotations=distance", timeout=TIMEOUT_S) as r:
            cuerpo = json.loads(r.read())
        if cuerpo.get("code") != "Ok":
            raise ValueError(f"{cuerpo.get('code')} {cuerpo.get('message', '')}".strip())
        distancias = cuerpo["distances"]
        ajustes = [w.get("distance", 0.0) or 0.0 for w in cuerpo.get("sources", [])]
    except Exception as e:  # noqa: BLE001 — cualquier falla de OSRM se cubre con el respaldo
        motivo = f"OSRM falló: {e!r}"
        with _candado:
            if not _estado["caido"]:
                _registrar(f"{motivo}; se usa línea recta × FACTOR_RUTA y se reintenta en {REINTENTO_S:g} s.")
            _estado.update(caido=True, caido_hasta=reloj() + REINTENTO_S)
        return {}, motivo
    with _candado:
        if _estado["caido"]:
            _registrar("OSRM volvió a responder: los tiempos se miden otra vez por calle.")
        _estado.update(caido=False, caido_hasta=0.0)

    fuera = {i for i, m in enumerate(ajustes) if m > MAX_AJUSTE_M}
    km = {}
    for i, a in enumerate(unicos):
        for j, b in enumerate(unicos):
            metros = distancias[i][j]
            if i in fuera or j in fuera or metros is None:
                continue
            km[(a, b)] = metros / 1000
    return km, None


def tiempo_por_calle(km, respaldo, velocidad_kmh):
    """Función (a, b) -> minutos: por calle si el tramo está en `km`; si no, el respaldo.

    Lleva la cuenta de cuántos tramos usaron cada fuente, para decirlo en la respuesta.
    """
    usos = {"calle": 0, "linea_recta": 0}

    def tiempo(a, b):
        tramo = km.get((_clave(a), _clave(b)))
        if tramo is None:
            usos["linea_recta"] += 1
            return respaldo(a, b)
        usos["calle"] += 1
        return tramo / velocidad_kmh * 60

    tiempo.usos = usos
    return tiempo


def reiniciar():
    """Para las pruebas: olvida si OSRM estaba caído."""
    with _candado:
        _estado.update(caido=False, caido_hasta=0.0)

"""Tiempos por calle con OSRM, su respaldo y el interruptor (tiempos = haversine | osrm). Sin red."""

import copy
import io
import json
import sys
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import algoritmo  # noqa: E402
import calles  # noqa: E402
from test_contrato import CLIENTE, RESTAURANTE, moto, peticion  # noqa: E402


def osrm_falso(factor=1.6, ajuste_m=5.0, llamadas=None):
    """Un OSRM que mide cada tramo como la línea recta × factor (en metros)."""

    def abrir(url, timeout):
        if llamadas is not None:
            llamadas.append(url)
        coords = url.split("/table/v1/driving/")[1].split("?")[0].split(";")
        puntos = [(float(c.split(",")[1]), float(c.split(",")[0])) for c in coords]
        distancias = [[algoritmo.haversine_km(a, b) * 1000 * factor for b in puntos] for a in puntos]
        cuerpo = {"code": "Ok", "distances": distancias, "sources": [{"distance": ajuste_m} for _ in puntos]}
        return io.BytesIO(json.dumps(cuerpo).encode())

    return abrir


def caido(url, timeout):
    raise TimeoutError("timed out")


def sin_tiempos(r):
    r = copy.deepcopy(r)
    r.pop("tiempos")
    return r


def con_osrm(abrir):
    return mock.patch.object(calles.urllib.request, "urlopen", abrir)


class Interruptor(unittest.TestCase):
    def setUp(self):
        calles.reiniciar()

    def motos(self):
        en_curso = [{"tipo": "C", "punto": [3.3700, -76.5300], "pedido": 101}]
        return [moto("Ana"), moto("Beto", lat=3.3500, lon=-76.5300, paradas=en_curso, entregas=1)]

    def test_apagado_es_identico_a_antes(self):
        """tiempos = haversine da lo mismo que evaluar() con su tiempo por defecto, sin llamar a OSRM."""
        p = peticion(self.motos(), listo_en=8)
        llamadas = []
        with mock.patch.dict("os.environ", {"OSRM_URL": "http://osrm:5000"}), \
                con_osrm(osrm_falso(llamadas=llamadas)):
            r = algoritmo.evaluar_peticion(p)
        self.assertEqual(llamadas, [])
        motos = [dict(m, paradas=[dict(x) for x in m["paradas"]]) for m in p["motos"]]
        ev = algoritmo.evaluar(motos, tuple(RESTAURANTE), tuple(CLIENTE), 3.0, p["ahora"], modo="pico",
                               t_listo=8.0, multipedido=True)
        self.assertEqual(r["ganador"], ev["ganador"])
        self.assertEqual([m["score"] for m in r["motos"] if m["elegible"]],
                         [m["score"] for m in ev["motos"] if m["elegible"]])
        self.assertEqual(r["tiempos"]["fuente"], "haversine")

    def test_encendido_mide_por_calle(self):
        llamadas = []
        with mock.patch.dict("os.environ", {"OSRM_URL": "http://osrm:5000"}), \
                con_osrm(osrm_falso(factor=2.0, llamadas=llamadas)):
            r = algoritmo.evaluar_peticion(peticion([moto("Ana")], tiempos="osrm"))
        self.assertEqual(len(llamadas), 1)  # una sola consulta por evaluación
        self.assertEqual(r["tiempos"]["fuente"], "osrm")
        self.assertIsNone(r["tiempos"]["respaldo"])
        self.assertEqual(r["tiempos"]["tramos_linea_recta"], 0)
        # 2 veces la línea recta, a 25 km/h: más minutos que con el 1,3 de siempre.
        km = algoritmo.haversine_km((3.3604, -76.5240), tuple(RESTAURANTE)) * 2.0
        self.assertAlmostEqual(r["motos"][0]["t_a_min"], round(km / 25 * 60, 1), places=1)

    def test_osrm_caido_usa_el_respaldo_y_lo_dice(self):
        p = peticion([moto("Ana"), moto("Beto", lat=3.3520, lon=-76.5260)], listo_en=5)
        antes = algoritmo.evaluar_peticion(p)
        with mock.patch.dict("os.environ", {"OSRM_URL": "http://osrm:5000"}), con_osrm(caido), \
                mock.patch.object(calles, "_registrar") as registro:
            r = algoritmo.evaluar_peticion(dict(p, tiempos="osrm"))
        self.assertEqual(sin_tiempos(r), sin_tiempos(antes))  # misma decisión que con línea recta
        self.assertEqual(r["tiempos"]["fuente"], "haversine")
        self.assertIn("OSRM falló", r["tiempos"]["respaldo"])
        registro.assert_called_once()  # la caída queda en el registro

    def test_tras_una_caida_no_espera_otra_vez(self):
        llamadas = []

        def cuenta_y_falla(url, timeout):
            llamadas.append(url)
            raise ConnectionRefusedError()

        with mock.patch.dict("os.environ", {"OSRM_URL": "http://osrm:5000"}), con_osrm(cuenta_y_falla), \
                mock.patch.object(calles, "_registrar"):
            algoritmo.evaluar_peticion(peticion([moto("Ana")], tiempos="osrm"))
            r = algoritmo.evaluar_peticion(peticion([moto("Ana")], tiempos="osrm"))
        self.assertEqual(len(llamadas), 1)
        self.assertEqual(r["ganador"], "Ana")
        self.assertIn("caído", r["tiempos"]["respaldo"])

    def test_sin_osrm_url_usa_el_respaldo(self):
        with mock.patch.dict("os.environ", {"OSRM_URL": ""}):
            r = algoritmo.evaluar_peticion(peticion([moto("Ana")], tiempos="osrm"))
        self.assertEqual(r["ganador"], "Ana")
        self.assertEqual(r["tiempos"]["respaldo"], "sin OSRM_URL")

    def test_punto_fuera_del_mapa_va_en_linea_recta(self):
        with mock.patch.dict("os.environ", {"OSRM_URL": "http://osrm:5000"}), \
                con_osrm(osrm_falso(ajuste_m=2000)):
            r = algoritmo.evaluar_peticion(peticion([moto("Ana")], tiempos="osrm"))
        self.assertEqual(r["tiempos"]["fuente"], "haversine")
        self.assertEqual(r["tiempos"]["tramos_calle"], 0)


if __name__ == "__main__":
    unittest.main()

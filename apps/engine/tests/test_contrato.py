"""La entrada y la salida de evaluar_peticion siguen el contrato de docs/ALGORITMO.md."""

import copy
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import algoritmo  # noqa: E402

AHORA = 1790712000  # martes 29 de septiembre de 2026, 3:00 p.m. en Cali
RESTAURANTE = [3.3550, -76.5240]
CLIENTE = [3.3649, -76.5204]


def moto(id, lat=3.3604, lon=-76.5240, **extra):
    return {"id": id, "lat": lat, "lon": lon, "sin_senal": False, "entregas": 3, "cuota": 3.0,
            "disponible_desde_ts": AHORA - 600, "paradas": [], **extra}


def peticion(motos, listo_en=0, **extra):
    return {"ahora": AHORA, "modo": "pico", "multipedido": True, "radio_km": 3,
            "pedido": {"id": 1, "restaurante": RESTAURANTE, "cliente": CLIENTE, "listo_ts": AHORA + listo_en * 60},
            "motos": motos, "tiempos": "haversine", **extra}


class Respuesta(unittest.TestCase):
    def test_campos(self):
        r = algoritmo.evaluar_peticion(peticion([moto("Ana")]))
        self.assertEqual(set(r), {"engine_version", "modo", "pesos", "despacho", "ganador", "plan", "motos",
                                  "explicacion"})
        self.assertEqual(r["engine_version"], algoritmo.ENGINE_VERSION)
        self.assertEqual(r["ganador"], "Ana")
        self.assertNotIn("aportes", r["motos"][0])

    def test_plan_de_la_ganadora_con_horas(self):
        r = algoritmo.evaluar_peticion(peticion([moto("Ana")], listo_en=5))
        self.assertEqual(r["plan"], [
            {"tipo": "R", "punto": RESTAURANTE, "pedido": None, "listo_ts": AHORA + 300},
            {"tipo": "C", "punto": CLIENTE, "pedido": None},
        ])

    def test_plan_conserva_las_paradas_que_ya_lleva(self):
        en_curso = [{"tipo": "R", "punto": [3.3460, -76.5240], "pedido": 101, "listo_ts": AHORA + 120},
                    {"tipo": "C", "punto": [3.3730, -76.5186], "pedido": 101}]
        r = algoritmo.evaluar_peticion(peticion([moto("Ana", paradas=en_curso)]))
        self.assertEqual(r["ganador"], "Ana")
        self.assertEqual({p["pedido"] for p in r["plan"]}, {101, None})
        self.assertIn({"tipo": "R", "punto": [3.3460, -76.5240], "pedido": 101, "listo_ts": AHORA + 120}, r["plan"])

    def test_despacho_diferido(self):
        r = algoritmo.evaluar_peticion(peticion([moto("Ana")], listo_en=20))
        d = r["despacho"]
        self.assertGreater(d["faltan_min"], 0)
        self.assertEqual(d["listo_ts"], AHORA + 1200)
        self.assertAlmostEqual(d["despachar_ts"], AHORA + d["faltan_min"] * 60, delta=6)

    def test_sin_elegibles(self):
        r = algoritmo.evaluar_peticion(peticion([moto("Ana", lat=3.50)]))
        self.assertIsNone(r["ganador"])
        self.assertIsNone(r["plan"])
        self.assertEqual(r["motos"][0]["motivo"], "fuera_radio")

    def test_codigos_de_motivo(self):
        lleno = [{"tipo": "C", "punto": CLIENTE, "pedido": n} for n in (101, 102, 103)]
        espera = [{"tipo": "W", "punto": CLIENTE, "pedido": 104, "listo_ts": AHORA + 300},
                  {"tipo": "V", "punto": RESTAURANTE, "pedido": 104}]
        r = algoritmo.evaluar_peticion(peticion([
            moto("sin_senal", sin_senal=True), moto("lejos", lat=3.50),
            moto("lleno", paradas=lleno), moto("espera", paradas=espera)]))
        self.assertEqual({m["id"]: m["motivo"] for m in r["motos"]},
                         {"sin_senal": "sin_senal", "lejos": "fuera_radio", "lleno": "capacidad",
                          "espera": "cliente_no_contesta"})

    def test_no_modifica_la_peticion_y_es_reproducible(self):
        p = peticion([moto("Ana"), moto("Beto", lat=3.3325)], listo_en=8)
        original = copy.deepcopy(p)
        self.assertEqual(algoritmo.evaluar_peticion(p), algoritmo.evaluar_peticion(p))
        self.assertEqual(p, original)


class Modo(unittest.TestCase):
    def test_hora_de_cali(self):
        # 19:30 en Cali son las 00:30 UTC del día siguiente: debe ser pico sin importar el servidor.
        self.assertEqual(algoritmo.modo_por_hora(AHORA + 4.5 * 3600), "pico")
        self.assertEqual(algoritmo.modo_por_hora(AHORA + 3.98 * 3600), "valle")  # 18:58
        self.assertEqual(algoritmo.modo_por_hora(AHORA + 6.5 * 3600), "valle")   # 21:30

    def test_sin_modo_lo_calcula(self):
        r = algoritmo.evaluar_peticion(dict(peticion([moto("Ana")]), modo=None))
        self.assertEqual(r["modo"], "valle")
        r = algoritmo.evaluar_peticion(dict(peticion([moto("Ana")]), modo=None, ahora=AHORA + 4.5 * 3600))
        self.assertEqual(r["modo"], "pico")


class Equidad(unittest.TestCase):
    def test_gana_la_que_va_por_debajo_de_su_cuota(self):
        # Mismo lugar y mismas entregas; Beto acumuló más cuota porque estuvo conectado más tiempo.
        r = algoritmo.evaluar_peticion(peticion([moto("Ana", cuota=2.0), moto("Beto", cuota=5.0)], modo="valle"))
        self.assertEqual(r["ganador"], "Beto")

    def test_espera_desde_disponible(self):
        r = algoritmo.evaluar_peticion(peticion([moto("Ana", disponible_desde_ts=AHORA - 1800)]))
        self.assertEqual(r["motos"][0]["min_sin_pedido"], 30.0)
        self.assertEqual(r["motos"][0]["f_espera"], 100.0)


class Config(unittest.TestCase):
    def test_por_defecto_los_valores_actuales(self):
        self.assertEqual(algoritmo.configurar(), algoritmo.DEFAULTS)
        self.assertEqual(algoritmo.configurar({})["R_MAX_MIN"], 10.0)

    def test_sobrescribe_un_solo_modo(self):
        c = algoritmo.configurar({"PESOS": {"valle": [0.5, 0.0, 0.5]}})
        self.assertEqual(c["PESOS"]["pico"], algoritmo.DEFAULTS["PESOS"]["pico"])
        r = algoritmo.evaluar_peticion(peticion([moto("Ana")], modo="valle", config={"PESOS": {"valle": [0.5, 0.0, 0.5]}}))
        self.assertEqual(r["pesos"], [0.5, 0.0, 0.5])

    def test_cambia_el_resultado(self):
        lleno = [{"tipo": "C", "punto": CLIENTE, "pedido": n} for n in (101, 102)]
        p = peticion([moto("Ana", paradas=lleno)], modo="valle")
        self.assertIsNone(algoritmo.evaluar_peticion(p)["ganador"])
        self.assertEqual(algoritmo.evaluar_peticion(dict(p, config={"MAX_PEDIDOS": {"valle": 3}}))["ganador"], "Ana")

    def test_constante_desconocida(self):
        with self.assertRaises(ValueError):
            algoritmo.evaluar_peticion(peticion([moto("Ana")], config={"NO_EXISTE": 1}))


class Validacion(unittest.TestCase):
    def test_cliente_obligatorio(self):
        p = peticion([moto("Ana")])
        p["pedido"]["cliente"] = None
        with self.assertRaises(ValueError):
            algoritmo.evaluar_peticion(p)

    def test_solo_haversine_por_ahora(self):
        with self.assertRaises(ValueError):
            algoritmo.evaluar_peticion(peticion([moto("Ana")], tiempos="google"))

    def test_campo_faltante(self):
        p = peticion([moto("Ana")])
        del p["ahora"]
        with self.assertRaises(KeyError):
            algoritmo.evaluar_peticion(p)


if __name__ == "__main__":
    unittest.main()

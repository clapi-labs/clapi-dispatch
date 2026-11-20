"""Administradores que también domicilian (#120): una ventaja pequeña (VENTAJA_ADMIN) que desempata y
los prefiere en condiciones parecidas, sin quitarle el pedido a una moto mucho mejor ubicada."""

import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import algoritmo  # noqa: E402

AHORA = 1790712000  # martes 29 de septiembre de 2026, 3:00 p.m. en Cali
RESTAURANTE = [3.3550, -76.5240]
CLIENTE = [3.3649, -76.5204]
# Grados de latitud por metro, al norte del restaurante.
M = 1 / 111_320


def moto(id, metros=300, admin=None, **extra):
    m = {"id": id, "lat": RESTAURANTE[0] + metros * M, "lon": RESTAURANTE[1], "sin_senal": False, "entregas": 3,
         "cuota": 3.0, "disponible_desde_ts": AHORA - 600, "paradas": [], **extra}
    if admin is not None:
        m["admin"] = admin
    return m


def evaluar(motos, modo="pico", cliente=CLIENTE, **extra):
    return algoritmo.evaluar_peticion({
        "ahora": AHORA, "modo": modo, "multipedido": True, "radio_km": 5,
        "pedido": {"id": 1, "restaurante": RESTAURANTE, "cliente": cliente, "listo_ts": AHORA},
        "motos": motos, "tiempos": "haversine", **extra})


def por_id(r):
    return {m["id"]: m for m in r["motos"]}


class Desempate(unittest.TestCase):
    def test_misma_distancia_gana_el_admin(self):
        for modo in ("pico", "valle"):
            # La normal va primero en la lista: sin la ventaja, el empate sería suyo.
            r = evaluar([moto("Normal"), moto("Admin", admin=True)], modo=modo)
            self.assertEqual(r["ganador"], "Admin", modo)
            motos = por_id(r)
            self.assertAlmostEqual(motos["Admin"]["score"] - motos["Normal"]["score"], 3.5, delta=0.11, msg=modo)
            self.assertEqual(motos["Admin"]["ventaja_admin"], 3.5)
            self.assertEqual(motos["Normal"]["ventaja_admin"], 0.0)

    def test_a_pocos_metros_de_diferencia_gana_el_admin(self):
        r = evaluar([moto("Normal", metros=250), moto("Admin", metros=300, admin=True)])
        self.assertEqual(r["ganador"], "Admin")

    def test_la_explicacion_dice_que_lo_definio_la_prioridad_admin(self):
        r = evaluar([moto("Normal"), moto("Admin", admin=True)])
        self.assertIn("por prioridad admin", r["explicacion"])
        self.assertIn("es admin (+3.5)", r["explicacion"])


class Rotacion(unittest.TestCase):
    def test_dos_admins_se_turnan_por_la_equidad(self):
        """Pedido 1 para uno, pedido 2 para el otro, pedido 3 otra vez para el primero."""
        a = moto("Wilians", metros=300, admin=True)
        b = moto("Socio", metros=320, admin=True)
        normal = moto("Normal", metros=330)

        ganadores = []
        for pedido in range(3):
            r = evaluar([a, b, normal])
            ganador = r["ganador"]
            ganadores.append(ganador)
            # Entregó el pedido: suma una entrega y vuelve a estar libre desde ahora.
            quien = a if ganador == "Wilians" else b if ganador == "Socio" else normal
            quien["entregas"] += 1
            quien["disponible_desde_ts"] = AHORA - 60 * (2 - pedido)
        self.assertEqual(ganadores, ["Wilians", "Socio", "Wilians"])


class NoRompeElAlgoritmo(unittest.TestCase):
    def test_una_moto_normal_mucho_mas_cerca_gana(self):
        for modo in ("pico", "valle"):
            r = evaluar([moto("Normal", metros=100), moto("Admin", metros=1500, admin=True)], modo=modo)
            self.assertEqual(r["ganador"], "Normal", modo)

    def test_un_admin_muy_cargado_no_le_quita_el_pedido_a_una_libre(self):
        """Lleva dos pedidos a 3 km al occidente y el nuevo va 2 km al oriente: aunque esté más cerca del
        restaurante, tomarlo atrasa todo, y gana la libre."""
        al_oriente = [RESTAURANTE[0], -76.5060]
        en_curso = [{"tipo": "C", "punto": [3.3550, -76.5510], "pedido": 101},
                    {"tipo": "C", "punto": [3.3600, -76.5560], "pedido": 102}]
        r = evaluar([moto("Normal", metros=400), moto("Admin", metros=300, admin=True, paradas=en_curso)], cliente=al_oriente)
        self.assertEqual(r["ganador"], "Normal")

    def test_la_equidad_sigue_pesando_en_valle(self):
        """En valle la equidad pesa mucho: un admin con varias entregas de más no se lleva todo."""
        r = evaluar([moto("Normal", entregas=1), moto("Admin", admin=True, entregas=6)], modo="valle")
        self.assertEqual(r["ganador"], "Normal")


class Compatibilidad(unittest.TestCase):
    def test_sin_el_campo_admin_todo_queda_igual(self):
        sin_campo = evaluar([moto("Ana", metros=200), moto("Beto", metros=400)])
        con_false = evaluar([moto("Ana", metros=200, admin=False), moto("Beto", metros=400, admin=False)])
        self.assertEqual([(m["id"], m["score"]) for m in sin_campo["motos"]],
                         [(m["id"], m["score"]) for m in con_false["motos"]])
        self.assertTrue(all(m["ventaja_admin"] == 0.0 for m in sin_campo["motos"]))

    def test_la_ventaja_se_configura(self):
        r = evaluar([moto("Normal"), moto("Admin", admin=True)], config={"VENTAJA_ADMIN": 0.0})
        self.assertEqual(r["ganador"], "Normal")
        r = evaluar([moto("Normal", metros=100), moto("Admin", metros=1500, admin=True)], config={"VENTAJA_ADMIN": 50.0})
        self.assertEqual(r["ganador"], "Admin")

    def test_el_default_es_3_5(self):
        self.assertEqual(algoritmo.DEFAULTS["VENTAJA_ADMIN"], 3.5)


if __name__ == "__main__":
    unittest.main()

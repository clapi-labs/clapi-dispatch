"""Cada caso de casos/ con "esperado" debe dar la moto esperada."""

import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import casos  # noqa: E402


class Casos(unittest.TestCase):
    def test_casos(self):
        archivos = sorted(casos.DIR_CASOS.glob("*.json"))
        self.assertTrue(archivos)
        for archivo in archivos:
            caso = casos.cargar(archivo)
            for pedido, esperado, obtenido, _ in casos.verificar(caso, casos.ejecutar(caso)):
                with self.subTest(caso=archivo.name, pedido=pedido):
                    self.assertEqual(obtenido, esperado)


if __name__ == "__main__":
    unittest.main()

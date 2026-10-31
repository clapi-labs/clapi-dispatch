"""El servidor HTTP responde el contrato y convierte los errores en 4xx."""

import json
import sys
import threading
import unittest
import urllib.error
import urllib.request
from http.server import ThreadingHTTPServer
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import algoritmo  # noqa: E402
import api  # noqa: E402
from test_contrato import moto, peticion  # noqa: E402


class Api(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        api.Handler.log_message = lambda *a: None  # sin ruido en la salida de las pruebas
        cls.servidor = ThreadingHTTPServer(("127.0.0.1", 0), api.Handler)
        cls.url = f"http://127.0.0.1:{cls.servidor.server_address[1]}"
        threading.Thread(target=cls.servidor.serve_forever, daemon=True).start()

    @classmethod
    def tearDownClass(cls):
        cls.servidor.shutdown()
        cls.servidor.server_close()

    def pedir(self, ruta, cuerpo=None):
        datos = cuerpo if isinstance(cuerpo, bytes) or cuerpo is None else json.dumps(cuerpo).encode()
        req = urllib.request.Request(self.url + ruta, data=datos, headers={"Content-Type": "application/json"})
        try:
            with urllib.request.urlopen(req) as r:
                return r.status, json.loads(r.read())
        except urllib.error.HTTPError as e:
            return e.code, json.loads(e.read())

    def test_health(self):
        self.assertEqual(self.pedir("/health"), (200, {"ok": True, "engine_version": algoritmo.ENGINE_VERSION}))

    def test_evaluar(self):
        p = peticion([moto("Ana")])
        estado, cuerpo = self.pedir("/evaluar", p)
        self.assertEqual(estado, 200)
        self.assertEqual(cuerpo, json.loads(json.dumps(algoritmo.evaluar_peticion(p))))

    def test_errores(self):
        sin_ahora = {k: v for k, v in peticion([moto("Ana")]).items() if k != "ahora"}
        self.assertEqual(self.pedir("/evaluar", sin_ahora)[0], 400)
        self.assertEqual(self.pedir("/evaluar", b"{no es json")[0], 400)
        self.assertEqual(self.pedir("/evaluar", [1, 2])[0], 400)
        self.assertEqual(self.pedir("/evaluar", peticion([moto("Ana")], config={"X": 1}))[0], 400)
        self.assertEqual(self.pedir("/otra", {})[0], 404)
        self.assertEqual(self.pedir("/otra")[0], 404)


if __name__ == "__main__":
    unittest.main()

"""Servidor HTTP del engine: POST /evaluar y GET /health. Solo librería estándar.

No tiene puerto público: solo el bot lo alcanza por la red interna de Docker.
    PORT=3003 python3 api.py
"""

import json
import os
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import algoritmo

MAX_CUERPO = 1_000_000  # bytes; una petición real con decenas de motos pesa unos pocos KB


class Handler(BaseHTTPRequestHandler):
    server_version = "engine"
    sys_version = ""

    def responder(self, estado, cuerpo):
        datos = json.dumps(cuerpo, ensure_ascii=False).encode()
        self.send_response(estado)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(datos)))
        self.end_headers()
        self.wfile.write(datos)

    def do_GET(self):
        if self.path == "/health":
            self.responder(200, {"ok": True, "engine_version": algoritmo.ENGINE_VERSION})
        else:
            self.responder(404, {"error": "No encontrado"})

    def do_POST(self):
        if self.path != "/evaluar":
            self.responder(404, {"error": "No encontrado"})
            return
        try:
            largo = int(self.headers.get("Content-Length", 0))
        except ValueError:
            largo = -1
        if not 0 < largo <= MAX_CUERPO:
            self.responder(400 if largo <= 0 else 413, {"error": "Cuerpo vacío o demasiado grande"})
            return
        try:
            peticion = json.loads(self.rfile.read(largo))
            if not isinstance(peticion, dict):
                raise ValueError("La petición debe ser un objeto JSON")
            self.responder(200, algoritmo.evaluar_peticion(peticion))
        except KeyError as e:
            self.responder(400, {"error": f"Falta el campo {e}"})
        except (ValueError, TypeError) as e:  # JSON inválido o valores con tipo equivocado
            self.responder(400, {"error": str(e)})
        except Exception as e:  # noqa: BLE001 — se registra y el bot sigue con la cola actual
            self.log_error("error al evaluar: %r", e)
            self.responder(500, {"error": "Error interno del engine"})

    def log_request(self, code="-", size="-"):
        if self.path != "/health":  # el healthcheck corre cada pocos segundos
            super().log_request(code, size)


def main():
    puerto = int(os.environ.get("PORT", "3003"))
    servidor = ThreadingHTTPServer(("0.0.0.0", puerto), Handler)
    print(f"engine {algoritmo.ENGINE_VERSION} escuchando en :{puerto}", flush=True)
    servidor.serve_forever()


if __name__ == "__main__":
    main()

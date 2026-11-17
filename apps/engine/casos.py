"""Casos de prueba del algoritmo de asignación.

Cada caso es un archivo JSON en casos/ (formato explicado en casos/LEEME.md) con motos, pedidos
en curso, pedidos nuevos y, opcionalmente, qué moto debería ganar cada pedido. Cada pedido se
evalúa armando la misma petición que mandará el bot (algoritmo.evaluar_peticion), así que los
casos prueban también el contrato.

Uso:
    python3 casos.py                  # corre todos los casos
    python3 casos.py casos/02-*.json  # corre solo algunos
    python3 casos.py --detalle        # además muestra el ranking completo de cada pedido
"""

import glob
import json
import sys
from pathlib import Path

import algoritmo

DIR_CASOS = Path(__file__).parent / "casos"
ID_EN_CURSO = 100  # los pedidos que las motos ya llevan se numeran desde 101
ID_PENDIENTE = 200  # y los pendientes de regreso, desde 201
# Hora fija, para que los casos den siempre lo mismo (un martes a las 3:00 p.m. en Cali). La hora ya
# no decide el modo: lo fija cada caso, y sin modo en el JSON corre en pico.
AHORA = 1790712000


def cargar(archivo):
    ruta = Path(archivo)
    if not ruta.is_absolute() and not ruta.exists():
        ruta = DIR_CASOS / archivo
    return json.loads(ruta.read_text(encoding="utf-8"))


def config(caso):
    c = {"modo": "pico", "radio": 3, "multi": True, "motor": "haversine"}
    c.update(caso.get("config", {}))
    return c


def paradas_de_plan(plan, id_pedido):
    """El plan de la respuesta, con el id del pedido nuevo en lugar de None (lo que guardará el bot)."""
    return [dict(p, pedido=id_pedido if p["pedido"] is None else p["pedido"]) for p in plan]


def demanda(caso):
    """La del caso, o la del modo (pico = alta, valle = baja). "auto" corre en valle."""
    c = config(caso)
    return c.get("demanda") or algoritmo.DEMANDA_DEL_MODO.get(c["modo"], "baja")


def ubicar_regreso(paradas, regreso, nivel):
    """Dónde entra un regreso que el plan todavía no conocía, igual que en el bot
    (packages/shared/src/domain/route.ts): con demanda baja, apenas entregue lo que lleva encima y
    antes de la siguiente recogida; con demanda alta, al final."""
    if nivel == "alta":
        return paradas + [regreso]
    # El primer momento en que no lleva comida de nadie.
    recoge = {p["pedido"] for p in paradas if p["tipo"] == "R"}
    a_bordo = {p["pedido"] for p in paradas if p["tipo"] == "C"} - recoge
    for k, p in enumerate(paradas):
        if not a_bordo:
            return paradas[:k] + [regreso] + paradas[k:]
        if p["tipo"] == "R":
            a_bordo.add(p["pedido"])
        elif p["tipo"] == "C":
            a_bordo.discard(p["pedido"])
    return paradas + [regreso]


def construir(caso, ahora=AHORA):
    """Arma el estado inicial del caso: motos (con paradas en horas absolutas) y pedidos por id.

    Los pedidos nuevos usan los ids 1, 2, 3... en el orden del archivo; los que las motos ya
    llevan, 101, 102...; los pendientes de regreso, 201, 202...
    """
    motos, pedidos = [], {}
    id_en_curso = ID_EN_CURSO
    id_pendiente = ID_PENDIENTE
    nivel = demanda(caso)
    for m in caso["motos"]:
        moto = {"id": m["id"], "lat": m["lat"], "lon": m["lon"], "entregas": m.get("entregas", 0),
                "cuota": m.get("cuota"), "disponible_desde_ts": ahora - m.get("min_sin_pedido", 0) * 60,
                "paradas": [], "pendientes": []}
        # Los pedidos ya recogidos solo tienen pendiente la entrega; los demás se ubican en la ruta
        # con la misma búsqueda del mejor orden que usa el algoritmo al asignar.
        en_curso = m.get("pedidos_en_curso", [])
        ids = list(range(id_en_curso + 1, id_en_curso + 1 + len(en_curso)))
        id_en_curso += len(en_curso)
        for id_pedido, p in zip(ids, en_curso):
            if "cliente_no_contesta_hace" in p:  # la moto está donde el cliente, esperando
                quedan = max(0.0, algoritmo.ESPERA_CLIENTE_MIN - p["cliente_no_contesta_hace"])
                moto["paradas"][:0] = [
                    {"tipo": "W", "punto": p["cliente"], "pedido": id_pedido, "listo_ts": ahora + quedan * 60},
                    {"tipo": "V", "punto": p["restaurante"], "pedido": id_pedido}]
            elif p.get("recogido", False):
                moto["paradas"].append({"tipo": "C", "punto": p["cliente"], "pedido": id_pedido})
        for id_pedido, p in zip(ids, en_curso):
            listo_ts = ahora + p.get("listo_en", 0) * 60
            if not p.get("recogido", False) and "cliente_no_contesta_hace" not in p:
                paradas = [dict(q, t_listo=max(0.0, (q["listo_ts"] - ahora) / 60)) if "listo_ts" in q else q
                           for q in moto["paradas"]]
                ruta = algoritmo.mejor_insercion((m["lat"], m["lon"]), paradas, tuple(p["restaurante"]),
                                                 tuple(p["cliente"]), p.get("listo_en", 0))
                if ruta:
                    moto["paradas"] = [{k: v for k, v in q.items() if k != "t_listo"} for q in ruta["plan"]]
                    for q in moto["paradas"]:
                        if q["pedido"] is None:
                            q["pedido"] = id_pedido
                            if q["tipo"] == "R":
                                q["listo_ts"] = listo_ts
                else:
                    moto["paradas"] += [
                        {"tipo": "R", "punto": p["restaurante"], "pedido": id_pedido, "listo_ts": listo_ts},
                        {"tipo": "C", "punto": p["cliente"], "pedido": id_pedido}]
            pedidos[id_pedido] = {"id": id_pedido, "estado": "asignado", "moto": m["id"]}
        # Pendientes de regreso: los que declaró al recoger un pedido en curso ("pendiente") y los que
        # ya traía. El datáfono siempre va en la ruta; la plata, solo si "en_ruta" (con demanda baja,
        # cuando quedó libre).
        declarados = [{"motivo": p["pendiente"], "restaurante": p["restaurante"]}
                      for p in en_curso if p.get("pendiente")]
        for d in declarados + m.get("pendientes", []):
            if d["motivo"] not in algoritmo.MOTIVOS:
                raise ValueError(f"Motivo desconocido en {m['id']}: {d['motivo']}")
            id_pendiente += 1
            regreso = {"tipo": "B", "punto": d["restaurante"], "pedido": id_pendiente, "motivo": d["motivo"]}
            if d.get("en_ruta", d["motivo"] == "datafono"):
                moto["paradas"] = ubicar_regreso(moto["paradas"], regreso, nivel)
            else:
                moto["pendientes"].append({k: v for k, v in regreso.items() if k != "tipo"})
        motos.append(moto)
    for i, p in enumerate(caso.get("pedidos", []), start=1):
        pedidos[i] = {"id": i, "restaurante": p["restaurante"], "cliente": p.get("cliente"),
                      "listo_ts": ahora + p.get("listo_en", 0) * 60, "estado": "pendiente", "moto": None,
                      "nombre": p.get("nombre")}
    return motos, pedidos


def peticion(caso, motos, pedido, ahora=AHORA):
    """La petición a POST /evaluar. Si el caso no da la cuota de una moto, se usa el promedio de
    entregas del grupo: equivale a la cuota justa cuando todas llevan conectadas todo el turno."""
    c = config(caso)
    promedio = sum(m["entregas"] for m in motos) / len(motos) if motos else 0.0
    return {
        "ahora": ahora,
        "modo": None if c["modo"] == "auto" else c["modo"],
        "demanda": c.get("demanda"),
        "multipedido": bool(c["multi"]),
        "radio_km": float(c["radio"]),
        "pedido": {"id": pedido["id"], "restaurante": pedido["restaurante"], "cliente": pedido["cliente"],
                   "listo_ts": pedido["listo_ts"]},
        "motos": [{"id": m["id"], "lat": m["lat"], "lon": m["lon"], "sin_senal": False,
                   "entregas": m["entregas"], "cuota": promedio if m["cuota"] is None else m["cuota"],
                   "disponible_desde_ts": m["disponible_desde_ts"], "paradas": m["paradas"],
                   "pendientes": m["pendientes"]}
                  for m in motos],
        "tiempos": "haversine",
    }


def ejecutar(caso, ahora=AHORA):
    """Asigna los pedidos nuevos en orden, como llegarían por el bot. Devuelve el detalle de cada uno."""
    motos, pedidos = construir(caso, ahora)
    resultados = []
    for id_pedido in sorted(i for i, p in pedidos.items() if p["estado"] == "pendiente"):
        p = pedidos[id_pedido]
        ev = algoritmo.evaluar_peticion(peticion(caso, motos, p, ahora))
        if ev["ganador"] is not None:
            moto = next(m for m in motos if m["id"] == ev["ganador"])
            moto["paradas"] = paradas_de_plan(ev["plan"], id_pedido)
            # El pendiente que se hace en la misma vuelta ya está en la ruta.
            en_ruta = {p["pedido"] for p in moto["paradas"] if p["tipo"] == "B"}
            moto["pendientes"] = [p for p in moto["pendientes"] if p["pedido"] not in en_ruta]
            p.update(estado="asignado", moto=ev["ganador"])
        resultados.append({"pedido": id_pedido, "nombre": p.get("nombre"),
                           "t_listo": round(max(0.0, (p["listo_ts"] - ahora) / 60), 1),
                           "ganador": ev["ganador"], "evaluacion": ev})
    return resultados


def orden(plan):
    """Los tipos de parada del plan, en orden: "C B R C"."""
    return " ".join(p["tipo"] for p in plan or [])


def verificar(caso, resultados):
    """Compara con "esperado". Devuelve una lista de (pedido, esperado, obtenido, ok). Si el esperado
    trae "orden", también se compara el orden de las paradas de la ganadora."""
    por_pedido = {r["pedido"]: r for r in resultados}
    chequeos = []
    for e in caso.get("esperado", []):
        r = por_pedido.get(e["pedido"])
        ganador = r["ganador"] if r else None
        esperado, obtenido = e["moto"], ganador
        if "orden" in e:
            esperado = f"{e['moto']}: {e['orden']}"
            obtenido = f"{ganador}: {orden(r['evaluacion']['plan']) if r else ''}"
        chequeos.append((e["pedido"], esperado, obtenido, esperado == obtenido))
    return chequeos


# ---------- Reporte en consola ----------

def _f(v):
    return "–" if v is None else f"{v:5.1f}"


def reporte(archivo, detalle=False):
    caso = cargar(archivo)
    resultados = ejecutar(caso)
    chequeos = verificar(caso, resultados)
    c = config(caso)

    print("=" * 78)
    print(f"{caso.get('nombre', archivo)}  [{Path(archivo).name}]")
    if caso.get("descripcion"):
        print(f"  {caso['descripcion']}")
    if resultados:
        ev = resultados[0]["evaluacion"]
        w, modo = ev["pesos"], ev["modo"]
        print(f"  Modo {modo} · radio {c['radio']} km · varios pedidos por moto: "
              f"{'sí, hasta ' + str(algoritmo.DEFAULTS['MAX_PEDIDOS'][modo]) if c['multi'] else 'no'} · "
              f"pesos tiempo {w[0]:.2f} / ruta {w[1]:.2f} / equidad {w[2]:.2f}")

    esperado = {e["pedido"]: e for e in caso.get("esperado", [])}
    for r in resultados:
        ev = r["evaluacion"]
        nombre = f" ({r['nombre']})" if r["nombre"] else ""
        faltan = ev["despacho"]["faltan_min"]
        cuando = f" · se asigna en {faltan} min (asignación diferida)" if faltan > 0 else ""
        print(f"\n  Pedido {r['pedido']}{nombre} · listo en {r['t_listo']} min{cuando}")
        if r["ganador"]:
            g = ev["motos"][0]
            print(f"    → {g['id']} (Score {g['score']}): {ev['explicacion']}")
            print(f"      Ruta: {g['secuencia']} · llega al restaurante en {g['t_a_min']} min")
        else:
            print("    → Ninguna moto elegible")
        if r["pedido"] in esperado:
            e = esperado[r["pedido"]]
            ok = e["moto"] == r["ganador"]
            if "orden" in e:
                ok = ok and orden(ev["plan"]) == e["orden"]
            que = f"{e['moto']}" + (f" con la ruta {e['orden']}" if "orden" in e else "")
            print(f"    {'✅' if ok else '❌'} Esperado: {que}" + (f" — {e['por']}" if e.get("por") else ""))
        if detalle or not r["ganador"]:
            print(f"      {'Moto':10} {'Score':>6} {'Tiempo':>6} {'Ruta':>6} {'Equid.':>6}  Llega   Detalle")
            for m in ev["motos"]:
                if m["elegible"]:
                    print(f"      {m['id']:10} {_f(m['score'])} {_f(m['f_tiempo'])} {_f(m['f_ruta'])} "
                          f"{_f(m['f_equidad'])}  {m['t_a_min']:4.1f}m  {m['secuencia']}")
                else:
                    print(f"      {m['id']:10} {'excluida':>27}         {m['motivo_texto']}")

    fallas = [ch for ch in chequeos if not ch[3]]
    if chequeos:
        print(f"\n  Resultado: {len(chequeos) - len(fallas)}/{len(chequeos)} pedidos como se esperaba")
    return chequeos


def main():
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    detalle = "--detalle" in sys.argv
    archivos = [f for patron in args for f in sorted(glob.glob(patron))] if args else \
        [str(p) for p in sorted(DIR_CASOS.glob("*.json"))]
    total = fallidos = 0
    casos_fallidos = []
    for archivo in archivos:
        chequeos = reporte(archivo, detalle)
        total += len(chequeos)
        malos = [ch for ch in chequeos if not ch[3]]
        fallidos += len(malos)
        if malos:
            casos_fallidos.append(Path(archivo).name)
    print("=" * 78)
    print(f"{len(archivos)} casos · {total - fallidos}/{total} pedidos como se esperaba")
    for nombre in casos_fallidos:
        print(f"  ❌ {nombre}")
    sys.exit(1 if fallidos else 0)


if __name__ == "__main__":
    main()

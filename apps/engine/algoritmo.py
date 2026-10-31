"""Score multi-factor de asignación (ver especificaciones.md de algoritmoDeli, secciones 3 y 4).

S = F_tiempo·W1 + F_ruta·W2 + F_equidad·W3, cada factor en escala 0–100.

Todo es puro: nada lee el reloj ni guarda estado entre llamadas. La entrada y la salida del
contrato (docs/ALGORITMO.md) están en evaluar_peticion.
"""

import math
from datetime import datetime, timedelta, timezone

ENGINE_VERSION = "2026.10.1"

RADIO_TIERRA_KM = 6371.0
# Colombia no tiene horario de verano: UTC−5 todo el año, sin depender de tzdata en la imagen.
HORA_CALI = timezone(timedelta(hours=-5))

# Constantes que se pueden sobrescribir en el campo "config" de cada petición.
DEFAULTS = {
    "FACTOR_RUTA": 1.3,           # la ruta por calles es ~30% más larga que la línea recta
    "VELOCIDAD_KMH": 25.0,        # velocidad promedio de una moto en ciudad

    # F_tiempo
    "ALFA_TARDE": 1.0,            # peso de que la comida espere a la moto (el cliente confirmó que es lo peor)
    "ALFA_TEMPRANO": 0.5,         # peso de que la moto espere a la comida
    "TAU_MIN": 10.0,

    # Asignación diferida: el pedido se asigna cuando la moto más rápida tiene que salir para llegar
    # MARGEN_DESPACHO_MIN antes de que la comida esté lista (mejor que espere la moto y no la comida).
    "MARGEN_DESPACHO_MIN": 2.0,

    # F_ruta
    "D50_MIN": 4.0,               # desvío con el que una moto ocupada queda igual que una libre
    "R_MAX_MIN": 10.0,            # retraso máximo permitido al pedido que la moto ya lleva
    "F_RUTA_LIBRE": 50.0,
    "MAX_PEDIDOS": {"pico": 3, "valle": 2},  # pico: dato del cliente; valle: pendiente de confirmar

    # F_equidad
    "S_EQUIDAD": 2.0,             # escala de F_carga, en entregas
    "T_MAX_ESPERA_MIN": 30.0,

    "PESOS": {"pico": (0.70, 0.20, 0.10), "valle": (0.30, 0.10, 0.60)},
    "BETA": {"pico": 0.2, "valle": 0.5},
    "HORARIO_PICO": ((19, 0), (21, 30)),  # alta demanda de 7:00 a 9:30 p.m., hora de Cali
}

# Si el cliente no contesta, se le espera esto y luego el pedido vuelve al restaurante. Lo usa
# quien arma las paradas "W", no el score.
ESPERA_CLIENTE_MIN = 10.0

NOMBRES_FACTOR = {"tiempo": "tiempo de llegada al restaurante", "ruta": "optimización de ruta",
                  "equidad": "equidad del turno"}


def configurar(config=None):
    """DEFAULTS con lo que traiga "config". En las constantes por modo se puede cambiar un solo modo."""
    c = dict(DEFAULTS)
    for clave, valor in (config or {}).items():
        if clave not in DEFAULTS:
            raise ValueError(f"Constante desconocida en config: {clave}")
        c[clave] = {**DEFAULTS[clave], **valor} if isinstance(DEFAULTS[clave], dict) else valor
    return c


def haversine_km(a, b):
    phi1, phi2 = math.radians(a[0]), math.radians(b[0])
    dphi = math.radians(b[0] - a[0])
    dlam = math.radians(b[1] - a[1])
    h = math.sin(dphi / 2) ** 2 + math.cos(phi1) * math.cos(phi2) * math.sin(dlam / 2) ** 2
    return 2 * RADIO_TIERRA_KM * math.asin(math.sqrt(h))


def tiempo_haversine(c=DEFAULTS):
    """Función (a, b) -> minutos estimados de viaje en moto entre dos puntos (lat, lon)."""
    return lambda a, b: haversine_km(a, b) * c["FACTOR_RUTA"] / c["VELOCIDAD_KMH"] * 60


def modo_por_hora(ahora, c=DEFAULTS):
    """'pico' dentro de HORARIO_PICO (hora de Cali), 'valle' el resto del día."""
    momento = datetime.fromtimestamp(ahora, HORA_CALI)
    inicio, fin = (tuple(h) for h in c["HORARIO_PICO"])
    return "pico" if inicio <= (momento.hour, momento.minute) < fin else "valle"


def pesos(modo, multipedido, c=DEFAULTS):
    w1, w2, w3 = c["PESOS"][modo]
    if multipedido:
        return w1, w2, w3
    return w1 / (w1 + w3), 0.0, w3 / (w1 + w3)


def f_tiempo(t_a, t_listo, c=DEFAULTS):
    """Llegar hasta MARGEN_DESPACHO_MIN antes de que la comida esté lista no se penaliza: es el objetivo."""
    g = t_a - t_listo
    penalizacion = c["ALFA_TARDE"] * max(0, g) + c["ALFA_TEMPRANO"] * max(0, -g - c["MARGEN_DESPACHO_MIN"])
    return 100 * math.exp(-penalizacion / c["TAU_MIN"]), g


def f_equidad(entregas, cuota, minutos_sin_pedido, modo, c=DEFAULTS):
    """La cuota justa la lleva el bot (especificaciones.md, 4.A): en cada entrega del turno, cada
    moto activa suma 1/N."""
    icd = cuota - entregas
    f_carga = 50 + 50 * math.tanh(icd / c["S_EQUIDAD"])
    f_espera = 100 * min(1.0, minutos_sin_pedido / c["T_MAX_ESPERA_MIN"])
    beta = c["BETA"][modo]
    return (1 - beta) * f_carga + beta * f_espera, f_carga, f_espera


def recorrer(pos, paradas, tiempo):
    """Recorre las paradas en orden. Devuelve la hora de llegada a cada una y los minutos en movimiento.

    Tipos de parada: "R" recoger, "C" entregar, "W" esperar a un cliente que no contesta,
    "V" devolver al restaurante un pedido no entregado. Si la parada tiene t_listo (recoger
    o esperar al cliente), la moto no sigue antes de ese minuto.
    """
    reloj = viaje = 0.0
    anterior = pos
    llegadas = []
    for parada in paradas:
        tramo = tiempo(anterior, tuple(parada["punto"]))
        reloj += tramo
        viaje += tramo
        llegadas.append(reloj)
        reloj = max(reloj, parada.get("t_listo", 0.0))
        anterior = tuple(parada["punto"])
    return llegadas, viaje


def describir(paradas):
    nombres = {"R": "Recoge", "C": "Entrega", "W": "Espera al cliente de", "V": "Devuelve al restaurante"}
    return " → ".join(f"{nombres[p['tipo']]} {'nuevo' if p['pedido'] is None else '#' + str(p['pedido'])}"
                      for p in paradas)


def mejor_insercion(pos, paradas, restaurante, cliente, t_listo, tiempo=None, c=DEFAULTS):
    """Prueba el pedido nuevo en todas las posiciones de la ruta pendiente de la moto.

    paradas: lista ordenada de {"tipo": "R"|"C", "punto": [lat, lon], "pedido": id, "t_listo": min}.
    La recogida nueva va siempre antes que su entrega, y el orden de las paradas existentes se respeta.
    Devuelve la opción factible que termina antes, o None si todas retrasan más de R_MAX_MIN alguna
    entrega que la moto ya tenía. La espera en restaurantes no cuenta como desvío (la penaliza F_tiempo).
    """
    tiempo = tiempo or tiempo_haversine(c)
    nueva_r = {"tipo": "R", "punto": restaurante, "pedido": None, "t_listo": t_listo}
    nueva_c = {"tipo": "C", "punto": cliente, "pedido": None} if cliente else None
    llegadas_base, viaje_base = recorrer(pos, paradas, tiempo)
    entrega_base = {p["pedido"]: t for p, t in zip(paradas, llegadas_base) if p["tipo"] == "C"}
    t_b = tiempo(restaurante, cliente) if cliente else 0.0

    mejor = None
    # Mientras la moto espera a un cliente que no contesta ("W", siempre al inicio de la ruta),
    # no puede ir a otro lado: el pedido nuevo solo se puede insertar después de esa espera.
    fijas = next((k for k, p in enumerate(paradas) if p["tipo"] != "W"), len(paradas))
    for i in range(fijas, len(paradas) + 1):
        con_r = paradas[:i] + [nueva_r] + paradas[i:]
        for j in (range(i + 1, len(con_r) + 1) if nueva_c else [None]):
            secuencia = con_r if j is None else con_r[:j] + [nueva_c] + con_r[j:]
            llegadas, viaje = recorrer(pos, secuencia, tiempo)
            retraso = max((t - entrega_base[p["pedido"]] for p, t in zip(secuencia, llegadas)
                           if p["tipo"] == "C" and p["pedido"] in entrega_base), default=0.0)
            if retraso > c["R_MAX_MIN"] or (mejor and llegadas[-1] >= mejor["fin"]):
                continue
            mejor = {"fin": llegadas[-1], "secuencia": secuencia, "retraso": retraso, "viaje": viaje,
                     "t_a": llegadas[secuencia.index(nueva_r)]}
    if mejor is None:
        return None
    return {
        "secuencia": describir(mejor["secuencia"]),
        "ruta_puntos": [list(pos)] + [list(p["punto"]) for p in mejor["secuencia"]],
        "t_a": mejor["t_a"],
        "desvio_min": max(0.0, mejor["viaje"] - viaje_base - t_b),
        "retraso_actual_min": mejor["retraso"],
        "plan": mejor["secuencia"],  # paradas en el orden elegido; las del pedido nuevo tienen pedido=None
    }


def evaluar(motos, restaurante, cliente, radio_km, ahora, modo="pico", t_listo=0.0, multipedido=True,
            tiempo=None, c=DEFAULTS):
    """Calcula el Score de cada moto para un pedido y las ordena de mejor a peor.

    motos: dicts con id, lat, lon, sin_senal, entregas, cuota, disponible_desde_ts y paradas
    pendientes (ver mejor_insercion). Los tiempos (t_listo) van en minutos desde `ahora`.
    tiempo: función (a, b) -> minutos de viaje. Por defecto, Haversine × FACTOR_RUTA.
    """
    tiempo = tiempo or tiempo_haversine(c)
    w1, w2, w3 = pesos(modo, multipedido, c)
    max_pedidos = c["MAX_PEDIDOS"][modo]

    # Paso 1: filtros y mejor ruta de cada moto candidata.
    resultados, candidatas = [], []
    for m in motos:
        pos = (m["lat"], m["lon"])
        r = {"id": m["id"], "distancia_km": round(haversine_km(pos, restaurante), 3),
             "elegible": False, "motivo": None, "motivo_texto": None}
        resultados.append(r)

        def excluir(codigo, texto):
            r.update(motivo=codigo, motivo_texto=texto)

        if m["sin_senal"]:
            excluir("sin_senal", "Sin señal GPS")
            continue
        if r["distancia_km"] > radio_km:
            excluir("fuera_radio", f"Fuera del radio de {radio_km:g} km")
            continue
        paradas = m["paradas"]
        en_curso = len({p["pedido"] for p in paradas})
        if any(p["tipo"] in "WV" for p in paradas):
            # Pendiente de definir con el cliente: qué pasa si una moto que espera a un cliente que no
            # contesta (o que vuelve a devolver ese pedido) recibe otro pedido. Mientras tanto, no participa.
            excluir("cliente_no_contesta", "Resolviendo un cliente que no contesta")
            continue
        if paradas and not multipedido:
            excluir("ocupada_sin_multipedido", "Ocupada (multi-pedido desactivado)")
            continue
        if en_curso >= max_pedidos:
            excluir("capacidad", f"Capacidad completa ({max_pedidos} pedidos)")
            continue
        ruta = mejor_insercion(pos, paradas, restaurante, cliente, t_listo, tiempo, c)
        if ruta is None:
            excluir("retraso", f"Retrasaría más de {c['R_MAX_MIN']:g} min un pedido que ya lleva")
            continue
        candidatas.append((m, r, ruta))

    # Asignación diferida: el pedido se despacha cuando a la moto libre más rápida le toca salir
    # para llegar MARGEN_DESPACHO_MIN antes de que la comida esté lista. Las motos libres esperan
    # quietas hasta ese momento, así que se evalúan con t_listo_ef. Las ocupadas siguen su ruta
    # mientras tanto y llegan a la misma hora se les asigne ahora o después: se evalúan con t_listo.
    t_a_min = min((ruta["t_a"] for m, _, ruta in candidatas if not m["paradas"]), default=None)
    t_listo_ef = t_listo if t_a_min is None else min(t_listo, t_a_min + c["MARGEN_DESPACHO_MIN"])
    despacho = {"t_listo_min": t_listo, "t_listo_efectivo_min": t_listo_ef,
                "faltan_min": max(0.0, t_listo - t_listo_ef)}

    # Paso 2: Score de cada candidata.
    planes = {}
    for m, r, ruta in candidatas:
        paradas = m["paradas"]
        t_a = ruta["t_a"]
        if paradas:
            fr = 100 * 2 ** (-ruta["desvio_min"] / c["D50_MIN"])
        else:
            fr, ruta["desvio_min"] = c["F_RUTA_LIBRE"], None

        ft, g = f_tiempo(t_a, t_listo if paradas else t_listo_ef, c)
        sin_pedido = 0.0 if paradas else max(0.0, (ahora - m["disponible_desde_ts"]) / 60)
        fe, f_carga, f_espera = f_equidad(m["entregas"], m["cuota"], sin_pedido, modo, c)
        aportes = {"tiempo": ft * w1, "ruta": fr * w2, "equidad": fe * w3}
        planes[m["id"]] = ruta["plan"]

        r.update({
            "elegible": True,
            "score": round(sum(aportes.values()), 1),
            "f_tiempo": round(ft, 1), "f_ruta": round(fr, 1) if multipedido else None,
            "f_equidad": round(fe, 1), "f_carga": round(f_carga, 1), "f_espera": round(f_espera, 1),
            "aportes": aportes,
            "t_a_min": round(t_a, 1), "g_min": round(g, 1),
            "min_sin_pedido": round(sin_pedido, 1),
            "secuencia": ruta["secuencia"], "ruta_puntos": ruta["ruta_puntos"],
            "desvio_min": round(ruta["desvio_min"], 1) if ruta["desvio_min"] is not None else None,
        })

    elegibles = sorted((r for r in resultados if r["elegible"]), key=lambda r: -r["score"])
    excluidas = sorted((r for r in resultados if not r["elegible"]), key=lambda r: r["distancia_km"])
    explicacion = explicar(elegibles)
    for r in elegibles:
        del r["aportes"]  # solo sirven para la explicación
    ganador = elegibles[0]["id"] if elegibles else None
    return {"motos": elegibles + excluidas, "pesos": [w1, w2, w3], "modo": modo, "despacho": despacho,
            "ganador": ganador, "plan": planes.get(ganador), "explicacion": explicacion}


def explicar(elegibles):
    """Frase para el motorizado: qué factor le dio la ventaja sobre el segundo lugar."""
    if not elegibles:
        return None
    ganador = elegibles[0]
    if len(elegibles) == 1:
        return f"{ganador['id']}: única moto elegible para este pedido"
    segundo = elegibles[1]
    ventaja = {k: ganador["aportes"][k] - segundo["aportes"][k] for k in ganador["aportes"]}
    factor = max(ventaja, key=ventaja.get)
    return (f"Servicio asignado a {ganador['id']} por {NOMBRES_FACTOR[factor]} "
            f"({ganador['score']} vs {segundo['score']} de {segundo['id']})")


def evaluar_peticion(peticion):
    """POST /evaluar: recibe y devuelve el JSON del contrato (docs/ALGORITMO.md).

    Las horas llegan como segundos Unix; aquí se pasan a minutos desde `ahora`, que es lo que usa
    el score, y el plan de la ganadora vuelve con horas otra vez. Un campo obligatorio que falte
    lanza KeyError; un valor inválido, ValueError.
    """
    c = configurar(peticion.get("config"))
    if peticion.get("tiempos", "haversine") != "haversine":
        raise ValueError("Por ahora solo se admite tiempos = haversine")  # Google llega en el paso 4
    ahora = float(peticion["ahora"])
    modo = peticion.get("modo") or modo_por_hora(ahora, c)
    if modo not in c["PESOS"]:
        raise ValueError(f"Modo desconocido: {modo}")
    pedido = peticion["pedido"]
    if not pedido.get("cliente"):
        raise ValueError("pedido.cliente es obligatorio")

    def minutos_hasta(ts):
        return max(0.0, (ts - ahora) / 60)

    motos = [dict(m, paradas=[dict(p, t_listo=minutos_hasta(p["listo_ts"])) if "listo_ts" in p else dict(p)
                              for p in m.get("paradas", [])])
             for m in peticion["motos"]]
    ev = evaluar(motos, tuple(pedido["restaurante"]), tuple(pedido["cliente"]), float(peticion["radio_km"]),
                 ahora, modo=modo, t_listo=minutos_hasta(pedido["listo_ts"]),
                 multipedido=bool(peticion["multipedido"]), c=c)

    faltan = ev["despacho"]["faltan_min"]
    plan = None
    if ev["plan"] is not None:
        plan = []
        for p in ev["plan"]:
            parada = {"tipo": p["tipo"], "punto": list(p["punto"]), "pedido": p["pedido"]}
            if "listo_ts" in p:
                parada["listo_ts"] = p["listo_ts"]
            elif p["tipo"] == "R" and p["pedido"] is None:
                parada["listo_ts"] = pedido["listo_ts"]
            plan.append(parada)

    return {
        "engine_version": ENGINE_VERSION,
        "modo": ev["modo"],
        "pesos": ev["pesos"],
        "despacho": {"listo_ts": pedido["listo_ts"], "despachar_ts": round(ahora + faltan * 60),
                     "faltan_min": round(faltan, 1)},
        "ganador": ev["ganador"],
        "plan": plan,
        "motos": ev["motos"],
        "explicacion": ev["explicacion"],
    }

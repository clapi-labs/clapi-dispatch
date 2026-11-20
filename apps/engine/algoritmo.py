"""Score multi-factor de asignación (ver especificaciones.md de algoritmoDeli, secciones 3 y 4).

S = F_tiempo·W1 + F_ruta·W2 + F_equidad·W3, cada factor en escala 0–100.

Todo es puro: nada lee el reloj ni guarda estado entre llamadas. La entrada y la salida del
contrato (docs/ALGORITMO.md) están en evaluar_peticion.
"""

import math

import calles

ENGINE_VERSION = "2026.11.4"

RADIO_TIERRA_KM = 6371.0

# Constantes que se pueden sobrescribir en el campo "config" de cada petición.
DEFAULTS = {
    "FACTOR_RUTA": 1.3,           # la ruta por calles es ~30% más larga que la línea recta (respaldo de OSRM)
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

    # Regresos al restaurante (pendientes: el datáfono, la plata). Ventaja, en puntos de Score, de la
    # moto que recoge el pedido nuevo en el restaurante donde tiene un pendiente: devuelve o paga en la
    # misma vuelta. Equivale a llegar ~1 min más tarde en pico y ~3 min en valle (docs/ALGORITMO.md).
    "VENTAJA_MISMO_RESTAURANTE": 8.0,
    "MISMO_LUGAR_KM": 0.05,       # sin id de restaurante, dos paradas a menos de esto son el mismo lugar

    # Administradores de la agencia que también domicilian (#120): ventaja pequeña, en puntos de Score,
    # para preferirlos en condiciones parecidas. Entre motos libres, llegar hasta MARGEN_DESPACHO_MIN
    # antes que otra no da puntos (las dos llegan a tiempo), así que ahí desempata; pasado ese margen,
    # cada minuto de más pesa ~6,6 puntos en pico y ~2,8 en valle, y la moto mejor ubicada gana. Con dos
    # administradores, los dos la tienen y se turnan por la equidad (docs/ALGORITMO.md, «Administradores»).
    "VENTAJA_ADMIN": 3.5,

    "PESOS": {"pico": (0.70, 0.20, 0.10), "valle": (0.30, 0.10, 0.60)},
    "BETA": {"pico": 0.2, "valle": 0.5},
}

# Si el cliente no contesta, se le espera esto y luego el pedido vuelve al restaurante. Lo usa
# quien arma las paradas "W", no el score.
ESPERA_CLIENTE_MIN = 10.0

NOMBRES_FACTOR = {"tiempo": "tiempo de llegada al restaurante", "ruta": "optimización de ruta",
                  "equidad": "equidad del turno", "pendiente": "un pendiente en el mismo restaurante",
                  "admin": "prioridad admin"}

# La demanda decide cuándo se vuelve al restaurante. Mientras el sistema no la mida (#59), sale del
# modo: pico = alta, valle = baja.
DEMANDA_DEL_MODO = {"pico": "alta", "valle": "baja"}
MOTIVOS = ("datafono", "plata")


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
    "V" devolver al restaurante un pedido no entregado, "B" regreso al restaurante por un pendiente
    (devolver el datáfono, pagar la comida): no ocupa lugar en la moto, pero su tiempo cuenta en la
    ruta. Si la parada tiene t_listo (recoger o esperar al cliente), la moto no sigue antes de ese minuto.
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
    regreso = {"datafono": "Devuelve el datáfono", "plata": "Paga"}

    def una(p):
        if p["tipo"] == "B":
            return f"{regreso.get(p.get('motivo'), 'Regresa')} (pendiente {p['pedido']})"
        return f"{nombres[p['tipo']]} {'nuevo' if p['pedido'] is None else '#' + str(p['pedido'])}"
    return " → ".join(una(p) for p in paradas)


def mismo_lugar(a, b, c=DEFAULTS):
    """Dos paradas en el mismo restaurante: por su id si las dos lo traen, si no por la distancia."""
    if a.get("restaurante_id") is not None and b.get("restaurante_id") is not None:
        return a["restaurante_id"] == b["restaurante_id"]
    return haversine_km(tuple(a["punto"]), tuple(b["punto"])) <= c["MISMO_LUGAR_KM"]


def junto_a_recogida(secuencia, k, c=DEFAULTS):
    """El regreso k va pegado a una recogida en ese mismo restaurante: es la misma vuelta."""
    b = secuencia[k]
    for paso in (-1, 1):
        i = k + paso
        while 0 <= i < len(secuencia) and mismo_lugar(secuencia[i], b, c):
            if secuencia[i]["tipo"] == "R":
                return True
            i += paso
    return False


def regresos_con_comida(secuencia, c=DEFAULTS):
    """Cuántos regresos se harían con comida de otro cliente encima. Nunca se vuelve como un desvío con
    un pedido a bordo, salvo que el regreso sea al mismo restaurante donde va a recoger."""
    recoge = {p["pedido"] for p in secuencia if p["tipo"] == "R"}
    a_bordo = {p["pedido"] for p in secuencia if p["tipo"] == "C"} - recoge  # ya recogidos
    malos = 0
    for k, p in enumerate(secuencia):
        if p["tipo"] == "R":
            a_bordo.add(p["pedido"])
        elif p["tipo"] == "C":
            a_bordo.discard(p["pedido"])
        elif p["tipo"] == "B" and a_bordo and not junto_a_recogida(secuencia, k, c):
            malos += 1
    return malos


def regreso_urgente(p, demanda):
    """Con demanda baja, el datáfono se devuelve apenas entregue lo que lleva: antes de recoger en otro
    restaurante. Con demanda alta se puede aplazar, y la plata nunca apura."""
    return p["tipo"] == "B" and p.get("motivo") == "datafono" and demanda == "baja"


def mejor_insercion(pos, paradas, restaurante, cliente, t_listo, tiempo=None, c=DEFAULTS, demanda="alta",
                    pendientes=(), restaurante_id=None):
    """Prueba el pedido nuevo en todas las posiciones de la ruta pendiente de la moto.

    paradas: lista ordenada de {"tipo": "R"|"C"|"B"…, "punto": [lat, lon], "pedido": id, "t_listo": min}.
    La recogida nueva va siempre antes que su entrega, y el orden de las paradas existentes se respeta.
    Devuelve la opción factible que termina antes, o None si todas retrasan más de R_MAX_MIN alguna
    entrega que la moto ya tenía. La espera en restaurantes no cuenta como desvío (la penaliza F_tiempo).

    Regresos ("B"): ninguno se hace con comida de otro cliente encima, salvo en el mismo restaurante
    donde recoge; con demanda baja, la recogida nueva no va antes de un datáfono por devolver, salvo
    que sea en ese mismo restaurante. pendientes: los que no están en la ruta (la plata con demanda
    alta, por ejemplo); el que sea del restaurante del pedido nuevo se hace pegado a la recogida.
    """
    tiempo = tiempo or tiempo_haversine(c)
    nueva_r = {"tipo": "R", "punto": restaurante, "pedido": None, "t_listo": t_listo}
    if restaurante_id is not None:
        nueva_r["restaurante_id"] = restaurante_id
    nueva_c = {"tipo": "C", "punto": cliente, "pedido": None} if cliente else None
    # El pendiente que no está en la ruta solo entra si es del mismo restaurante: no cuesta viaje.
    de_paso = [dict(p, tipo="B") for p in pendientes if mismo_lugar(p, nueva_r, c)]
    llegadas_base, viaje_base = recorrer(pos, paradas, tiempo)
    malos_base = regresos_con_comida(paradas, c)
    entrega_base = {p["pedido"]: t for p, t in zip(paradas, llegadas_base) if p["tipo"] == "C"}
    t_b = tiempo(restaurante, cliente) if cliente else 0.0

    mejor = None
    # Mientras la moto espera a un cliente que no contesta ("W", siempre al inicio de la ruta),
    # no puede ir a otro lado: el pedido nuevo solo se puede insertar después de esa espera.
    fijas = next((k for k, p in enumerate(paradas) if p["tipo"] != "W"), len(paradas))
    for i in range(fijas, len(paradas) + 1):
        # Con demanda baja, el datáfono va antes de recoger en otro restaurante; en el mismo, la
        # recogida puede ir justo antes del regreso: es la misma vuelta.
        urgentes = [p for p in paradas[i:] if regreso_urgente(p, demanda)]
        if urgentes and not (len(urgentes) == 1 and paradas[i] is urgentes[0] and mismo_lugar(urgentes[0], nueva_r, c)):
            continue
        con_r = paradas[:i] + [nueva_r] + de_paso + paradas[i:]
        for j in (range(i + 1 + len(de_paso), len(con_r) + 1) if nueva_c else [None]):
            secuencia = con_r if j is None else con_r[:j] + [nueva_c] + con_r[j:]
            llegadas, viaje = recorrer(pos, secuencia, tiempo)
            retraso = max((t - entrega_base[p["pedido"]] for p, t in zip(secuencia, llegadas)
                           if p["tipo"] == "C" and p["pedido"] in entrega_base), default=0.0)
            if retraso > c["R_MAX_MIN"] or (mejor and llegadas[-1] >= mejor["fin"]):
                continue
            if regresos_con_comida(secuencia, c) > malos_base:
                continue
            mejor = {"fin": llegadas[-1], "secuencia": secuencia, "retraso": retraso, "viaje": viaje,
                     "t_a": llegadas[secuencia.index(nueva_r)]}
    if mejor is None:
        return None
    sec = mejor["secuencia"]
    k_r = next(k for k, p in enumerate(sec) if p is nueva_r)
    # Qué pesó un pendiente: el regreso que se hace en la misma vuelta, y el datáfono que se aplaza
    # porque la demanda está alta (con demanda baja habría ido antes).
    aprovecha = [p for k, p in enumerate(sec) if p["tipo"] == "B" and mismo_lugar(p, nueva_r, c)
                 and junto_a_recogida(sec, k, c)]
    aplazados = [p for p in sec[k_r + 1:] if p["tipo"] == "B" and p.get("motivo") == "datafono"
                 and any(p is q for q in paradas) and not mismo_lugar(p, nueva_r, c)]
    return {
        "secuencia": describir(mejor["secuencia"]),
        "ruta_puntos": [list(pos)] + [list(p["punto"]) for p in mejor["secuencia"]],
        "t_a": mejor["t_a"],
        "desvio_min": max(0.0, mejor["viaje"] - viaje_base - t_b),
        "retraso_actual_min": mejor["retraso"],
        "plan": mejor["secuencia"],  # paradas en el orden elegido; las del pedido nuevo tienen pedido=None
        "aprovecha": aprovecha,
        "aplazados": aplazados,
    }


def evaluar(motos, restaurante, cliente, radio_km, ahora, modo="pico", t_listo=0.0, multipedido=True,
            tiempo=None, c=DEFAULTS, demanda=None, restaurante_id=None):
    """Calcula el Score de cada moto para un pedido y las ordena de mejor a peor.

    motos: dicts con id, lat, lon, sin_senal, entregas, cuota, disponible_desde_ts, paradas
    pendientes (ver mejor_insercion) y, opcionales, pendientes que no están en su ruta y admin. Los tiempos
    (t_listo) van en minutos desde `ahora`.
    tiempo: función (a, b) -> minutos de viaje. Por defecto, Haversine × FACTOR_RUTA.
    demanda: "alta" o "baja"; por defecto, la del modo.
    """
    tiempo = tiempo or tiempo_haversine(c)
    demanda = demanda or DEMANDA_DEL_MODO[modo]
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
        # El regreso no ocupa lugar en la moto: un pendiente no cuenta como pedido.
        en_curso = len({p["pedido"] for p in paradas if p["tipo"] != "B"})
        if any(p["tipo"] in "WV" for p in paradas):
            # Pendiente de definir con el cliente: qué pasa si una moto que espera a un cliente que no
            # contesta (o que vuelve a devolver ese pedido) recibe otro pedido. Mientras tanto, no participa.
            excluir("cliente_no_contesta", "Resolviendo un cliente que no contesta")
            continue
        if en_curso and not multipedido:
            excluir("ocupada_sin_multipedido", "Ocupada (multi-pedido desactivado)")
            continue
        if en_curso >= max_pedidos:
            excluir("capacidad", f"Capacidad completa ({max_pedidos} pedidos)")
            continue
        ruta = mejor_insercion(pos, paradas, restaurante, cliente, t_listo, tiempo, c, demanda=demanda,
                               pendientes=m.get("pendientes") or (), restaurante_id=restaurante_id)
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
        # Una moto que solo va a devolver o pagar no lleva pedidos: su espera cuenta para la equidad.
        con_pedidos = any(p["tipo"] != "B" for p in paradas)
        sin_pedido = 0.0 if con_pedidos else max(0.0, (ahora - m["disponible_desde_ts"]) / 60)
        fe, f_carga, f_espera = f_equidad(m["entregas"], m["cuota"], sin_pedido, modo, c)
        aportes = {"tiempo": ft * w1, "ruta": fr * w2, "equidad": fe * w3}
        aprovecha = ruta["aprovecha"]
        if aprovecha:
            aportes["pendiente"] = c["VENTAJA_MISMO_RESTAURANTE"]
        admin = bool(m.get("admin", False))
        if admin:
            aportes["admin"] = c["VENTAJA_ADMIN"]
        planes[m["id"]] = ruta["plan"]

        r.update({
            # Lo que pesó un pendiente de regreso (docs/ALGORITMO.md, «Regresos al restaurante»).
            "aprovecha": [{"pendiente": p["pedido"], "motivo": p.get("motivo")} for p in aprovecha],
            "regreso_aplazado": [p["pedido"] for p in ruta["aplazados"]],
            "ventaja_pendiente": c["VENTAJA_MISMO_RESTAURANTE"] if aprovecha else 0.0,
            "ventaja_admin": c["VENTAJA_ADMIN"] if admin else 0.0,
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
    return {"motos": elegibles + excluidas, "pesos": [w1, w2, w3], "modo": modo, "demanda": demanda,
            "despacho": despacho, "ganador": ganador, "plan": planes.get(ganador), "explicacion": explicacion}


QUE_HACE = {"datafono": "devuelve el datáfono", "plata": "paga"}


def explicar(elegibles):
    """Frase para la central: qué factor le dio la ventaja sobre el segundo lugar y, si pesó un
    pendiente de regreso, cuál."""
    if not elegibles:
        return None
    ganador = elegibles[0]
    if len(elegibles) == 1:
        frase = f"{ganador['id']}: única moto elegible para este pedido"
    else:
        segundo = elegibles[1]
        ventaja = {k: ganador["aportes"].get(k, 0.0) - segundo["aportes"].get(k, 0.0)
                   for k in set(ganador["aportes"]) | set(segundo["aportes"])}
        factor = max(ventaja, key=ventaja.get)
        frase = (f"Servicio asignado a {ganador['id']} por {NOMBRES_FACTOR[factor]} "
                 f"({ganador['score']} vs {segundo['score']} de {segundo['id']})")
    notas = []
    if ganador["aprovecha"]:
        que = " y ".join(dict.fromkeys(QUE_HACE.get(p["motivo"], "regresa") for p in ganador["aprovecha"]))
        notas.append(f"recoge donde tiene un pendiente y {que} en la misma vuelta "
                     f"(+{ganador['ventaja_pendiente']:g})")
    if ganador.get("ventaja_admin"):
        notas.append(f"es admin (+{ganador['ventaja_admin']:g})")
    if ganador["regreso_aplazado"]:
        notas.append("el regreso del datáfono se aplaza por demanda alta")
    return frase + "".join(f"; {n}" for n in notas)


def evaluar_peticion(peticion):
    """POST /evaluar: recibe y devuelve el JSON del contrato (docs/ALGORITMO.md).

    Las horas llegan como segundos Unix; aquí se pasan a minutos desde `ahora`, que es lo que usa
    el score, y el plan de la ganadora vuelve con horas otra vez. Un campo obligatorio que falte
    lanza KeyError; un valor inválido, ValueError.
    """
    c = configurar(peticion.get("config"))
    pedidos = peticion.get("tiempos", "haversine")
    if pedidos not in ("haversine", "osrm"):
        raise ValueError("tiempos debe ser haversine u osrm")  # Google llega en el paso 4
    ahora = float(peticion["ahora"])
    # El modo lo decide quien llama, con la demanda que mide (docs/ALGORITMO.md, «Demanda»):
    # alta = pico, baja = valle. Sin modo es valle; la hora no cuenta.
    modo = peticion.get("modo") or "valle"
    if modo not in c["PESOS"]:
        raise ValueError(f"Modo desconocido: {modo}")
    demanda = peticion.get("demanda") or DEMANDA_DEL_MODO[modo]
    if demanda not in ("alta", "baja"):
        raise ValueError(f"Demanda desconocida: {demanda}")
    pedido = peticion["pedido"]
    if not pedido.get("cliente"):
        raise ValueError("pedido.cliente es obligatorio")

    def minutos_hasta(ts):
        return max(0.0, (ts - ahora) / 60)

    motos = [dict(m, paradas=[dict(p, t_listo=minutos_hasta(p["listo_ts"])) if "listo_ts" in p else dict(p)
                              for p in m.get("paradas", [])])
             for m in peticion["motos"]]
    restaurante, cliente, radio_km = tuple(pedido["restaurante"]), tuple(pedido["cliente"]), float(peticion["radio_km"])
    tiempo, tiempos = medir_tiempos(pedidos, motos, restaurante, cliente, radio_km, c)
    ev = evaluar(motos, restaurante, cliente, radio_km,
                 ahora, modo=modo, t_listo=minutos_hasta(pedido["listo_ts"]),
                 multipedido=bool(peticion["multipedido"]), tiempo=tiempo, c=c, demanda=demanda,
                 restaurante_id=pedido.get("restaurante_id"))
    if pedidos == "osrm":
        usos = tiempo.usos
        tiempos.update(tramos_calle=usos["calle"], tramos_linea_recta=usos["linea_recta"],
                       fuente="osrm" if not usos["linea_recta"] else "haversine" if not usos["calle"] else "mixta")

    faltan = ev["despacho"]["faltan_min"]
    plan = None
    if ev["plan"] is not None:
        plan = []
        for p in ev["plan"]:
            parada = {"tipo": p["tipo"], "punto": list(p["punto"]), "pedido": p["pedido"]}
            for clave in ("motivo", "restaurante_id"):  # el regreso dice a qué vuelve y a dónde
                if p.get(clave) is not None:
                    parada[clave] = p[clave]
            if "listo_ts" in p:
                parada["listo_ts"] = p["listo_ts"]
            elif p["tipo"] == "R" and p["pedido"] is None:
                parada["listo_ts"] = pedido["listo_ts"]
            plan.append(parada)

    return {
        "engine_version": ENGINE_VERSION,
        "modo": ev["modo"],
        "demanda": ev["demanda"],
        "pesos": ev["pesos"],
        "despacho": {"listo_ts": pedido["listo_ts"], "despachar_ts": round(ahora + faltan * 60),
                     "faltan_min": round(faltan, 1)},
        "ganador": ev["ganador"],
        "plan": plan,
        "motos": ev["motos"],
        "explicacion": ev["explicacion"],
        "tiempos": tiempos,
    }


def medir_tiempos(pedidos, motos, restaurante, cliente, radio_km, c):
    """La función de minutos de viaje y qué fuente se pidió y se usó.

    "haversine": línea recta × FACTOR_RUTA, como siempre. "osrm": km por calle (calles.py) para todos
    los tramos que puede recorrer una moto que pase los filtros; lo que OSRM no mida, en línea recta.
    """
    respaldo = tiempo_haversine(c)
    if pedidos != "osrm":
        return respaldo, {"pedido": "haversine", "fuente": "haversine", "respaldo": None}
    # Solo los puntos de las motos que pueden competir: la que no tiene señal o está fuera del radio
    # queda excluida antes de calcular ninguna ruta.
    puntos = [restaurante, cliente]
    for m in motos:
        pos = (m["lat"], m["lon"])
        if not m["sin_senal"] and haversine_km(pos, restaurante) <= radio_km:
            puntos += [pos] + [tuple(p["punto"]) for p in m["paradas"]]
            puntos += [tuple(p["punto"]) for p in m.get("pendientes") or ()]
    km, motivo = calles.tabla_km(puntos)
    return calles.tiempo_por_calle(km, respaldo, c["VELOCIDAD_KMH"]), {"pedido": "osrm", "respaldo": motivo}

"""Armó la primera versión de casos.json: los puntos de la hoja de restaurantes
socios (copiados por la central del pin de Google Maps), las variantes como
llegan por WhatsApp, las trampas y los lugares por verificar. La hoja no se
versiona (trae los WhatsApp de los restaurantes).

    python3 apps/bot/direcciones/armar-casos.py <hoja.xlsx> apps/bot/direcciones/casos.json

Volver a correrlo reemplaza casos.json entero, con los puntos que se hayan
cargado después con direcciones:referencia: de ahí en adelante se edita
casos.json directamente. Ver docs/DIRECCIONES-Y-ZONAS.md, «Precisión de las
direcciones».
"""
import json
import sys

import openpyxl

hoja, salida = sys.argv[1], sys.argv[2]
ws = openpyxl.load_workbook(hoja, read_only=True).worksheets[0]
rows = {}
for i, r in enumerate(ws.iter_rows(values_only=True)):
    if i == 0 or not r[1]:
        continue
    lat, lng = [float(x) for x in str(r[5]).split(",")]
    rows[str(r[1]).strip()] = {"ficha": str(r[3]).strip(), "lat": round(lat, 6), "lng": round(lng, 6)}

FUENTE = "Pin de Google Maps de la ficha del restaurante socio, copiado por la central (clic derecho sobre el pin)"
VERIFICADO = "por la central, al registrar el restaurante"


def ref(name):
    row = rows[name]
    return {"lat": row["lat"], "lng": row["lng"], "lugar": name, "fuente": FUENTE, "verificado": VERIFICADO}


casos = []


def add(id, zona, tipo, texto, esperado="ubicar", municipio="cali", referencia=None, direccion=None, detalle=None, dudosa=False, nota=None):
    c = {"id": id, "zona": zona, "tipo": tipo, "texto": texto}
    if direccion:
        c["direccion"] = direccion
    if detalle:
        c["detalle"] = detalle
    c["esperado"] = esperado
    c["municipio"] = municipio
    if dudosa:
        c["dudosa"] = True
    c["referencia"] = referencia
    if nota:
        c["nota"] = nota
    casos.append(c)


# --- Estándar: la dirección de la ficha, como la escribiría el restaurante (sin «Comuna 17, Cali, Valle del Cauca»).
ESTANDAR = [
    ("747", "Cra 97 # 45-11 local 102"),
    ("Antojitos Mi Tierra Caribe", "Cl 45 # 97A-15 local 102"),
    ("Arepalandia", "Cra 83C # 48A-08"),
    ("Arepas de Choclo", "Cra 95A # 42-141"),
    ("Arepas Don Jhon", "Cra 95A # 45-10, Calicanto"),
    ("Arepas Kukuruza", "Cra 81 # 45-05"),
    ("Arroz Paisa Caney", "Cra 83C # 35A-07"),
    ("Bellamia", "Cl 48 # 86-125, Chill Plaza"),
    ("Benditarepa", "Cl 48 Bis # 92-27"),
    ("Capri Delicias", "Cl 42 # 81-15"),
    ("Contenedor de Arepas", "Cl 48 # 109-33, Bochalema"),
    ("Córner Ingenio", "Calle 16 Sur # 84A-31, El Ingenio"),
    ("Córner Valle del Lili", "Carrera 97 # 42-10, Calicanto"),
    ("D'amore", "Cra 85 # 43-76"),
    ("Dar Fresas", "Cra 97A # 42-30"),
    ("Delicias de Isa", "Cl 48 Bis # 92-11"),
    ("Dihuk", "Cl 48 # 106-83, Bochalema"),
    ("Don Parra", "Cra 83C # 37-31"),
    ("Dorilocos co", "Cra 98 # 42-55"),
    ("Droguería Hellen", "Cra 94A # 48A-70, Senderos"),
    ("Droguería Jhoana", "Cl 40 # 46B-15, Mariano Ramos"),
    ("Fries and Wings", "Cl 42 # 81-09"),
    ("Fritanga Buen Frito", "Cra 94A # 42-12"),
    ("Fruty Lovers", "Cra 97 # 42-110"),
    ("Grill Republic", "Cra 98 # 42-105, Fusión Plaza"),
    ("Hogareña Caney", "Cra 85A # 45"),
    ("Hogareña Ciudad Meléndez", "Cra 97 # 58-31, Ciudad Meléndez"),
    ("Home Pizza", "Cra 92 # 42-100 local 101"),
    ("Hunter Grill", "Cl 56 # 85C1-78"),
    ("Kelotes", "Cl 45 # 84-06 local 1"),
    ("Kiosco Caney", "Cl 45 # 83A-1"),
    ("Koi Sushi Ingenio", "Cl 16 # 83A-15"),
    ("La Cocina de Alba", "Cra 83 # 38-2"),
    ("La Esquina del Sabor", "Cra 96A # 42-146, Calicanto"),
    ("Los Weros", "Cra 95A # 42-09"),
    ("Mambas Burguer", "Cra 85B # 43-77"),
    ("Mi Sabor Llanero", "Cra 91 # 34-110"),
    ("Monkey Valle del Lili", "Cra 97A # 42-09"),
    ("Papelería Calicanto", "Cra 96A # 45-11 local 102"),
    ("Pizzaron Cali", "Cl 48 Bis # 92-07"),
    ("Rock&Bacoa", "Cra 95 # 42-09"),
    ("Salchipaisa", "Cra 98 # 45-41"),
    ("Succulentas", "Cl 45 # 81A-12"),
    ("Súper Deli empanaditas", "Cra 83 # 28-42"),
    ("Sushi Hatori", "Cra 95A # 42-17, Calicanto"),
    ("Tortas del Gordo Valle del lili", "Cra 86 # 38-111 local 11, Altos del Caney"),
    ("Varamar", "Cra 90 # 45-13"),
    ("Licores toro", "Cra 109 # 34-190"),
    ("Chino el primero emperador", "Cra 94A # 42-48"),
    ("Panadería la fortaleza", "Cra 96A # 45-11 local 101"),
]
for n, (name, texto) in enumerate(ESTANDAR, 1):
    zona = "oriente" if name == "Droguería Jhoana" else "sur"
    add(f"estandar-{n:02d}", zona, "estandar", texto, referencia=ref(name))

# --- Esquinas: un punto exacto en la ciudad, pero Google las devuelve como cruce.
ESQUINAS = [
    ("Bambú Burguer", "Calle 42 con Carrera 85C"),
    ("Fritanga Senderos", "Cra 92 con Cl 48A"),
    ("Punto Rojo", "Calle 42 con carrera 85C esquina"),
    ("Súper Droguería Store", "Carrera 97A con Calle 45, Calicanto"),
]
for n, (name, texto) in enumerate(ESQUINAS, 1):
    add(f"esquina-{n:02d}", "sur", "esquina", texto, referencia=ref(name), nota="Una esquina con calle y carrera: el punto existe aunque no haya placa.")

# --- Como llegan por WhatsApp: pegado, sin #, sin guion, mayúsculas, tildes, errores, puerta e indicaciones.
COLOQUIAL = [
    ("747", "cra97#45-11 loc 102", "cra97 # 45-11 loc 102", None),
    ("Arepas de Choclo", "kra 95a 42 141", None, None),
    ("Benditarepa", "cll 48bis 92-27", None, None),
    ("Kiosco Bochalema", "calle 48 # 106-83 local 17 bochalema", None, None),
    ("Arroz Paisa Caney", "cra 83c 35a 07 caney", None, None),
    ("Dorilocos co", "Carerra 98 # 42-55", None, None),
    ("Grill Republic", "Cra 98 #42-105 fusion plaza local 5, frente al parque", "Cra 98 # 42-105, Fusión Plaza", "Local 5"),
    ("Antojitos Mi Tierra Caribe", "Cl 45 #97a-15 torre 2 apto 502", "Cl 45 # 97a-15", "Torre 2 apto 502"),
    ("Hogareña Ciudad Meléndez", "Cra 97 # 58-31 Ciudad Melendez casa 6", "Cra 97 # 58-31 Ciudad Melendez", "Casa 6"),
    ("Córner Ingenio", "CALLE 16 SUR 84A-31 EL INGENIO", None, None),
    ("Capri Delicias", "cl.42 #81-15 caney", None, None),
    ("Arepalandia", "cra 83 c # 48 a - 08", None, None),
    ("Fritanga 97B / BENDITA TENTACION", "Cl 45 #9710", None, None),
    ("Droguería Hellen", "carrera 94a no. 48a-70 senderos, conjunto, dejar en porteria", "carrera 94a no. 48a-70 senderos", None),
    ("Mi Sabor Llanero", "Kr 91 # 34 - 110", None, None),
    ("Licores toro", "Cra. 109 #34-190 diagonal a la tienda", "Cra. 109 #34-190", None),
]
for n, (name, texto, direccion, detalle) in enumerate(COLOQUIAL, 1):
    add(f"coloquial-{n:02d}", "sur", "coloquial", texto, direccion=direccion, detalle=detalle, referencia=ref(name))

# --- Trampas y bordes: municipio cruzado, incompletas, solo barrio, fuera del área.
add("trampa-01", "jamundi", "trampa", "Calle 30 #1-15 jamundi", esperado="cualquiera", municipio="jamundi",
    nota="El caso de 6256a75: caía en Ciudad Pacífica (Cali). Nunca puede quedar en Cali.")
add("trampa-02", "oriente", "trampa", "Calle 30 # 1-15", esperado="cualquiera", municipio="cali",
    nota="La misma placa sin municipio: es Cali.")
add("trampa-03", "yumbo", "trampa", "Cra 10 # 5-20, Yumbo", esperado="cualquiera", municipio="yumbo",
    nota="Placa que también existe en Cali: no puede quedar en Cali.")
add("trampa-04", "jamundi", "trampa", "Calle 10 # 5-20 Jamundí", esperado="cualquiera", municipio="jamundi")
add("trampa-05", "otro", "trampa", "Calle 13 # 5-20 Candelaria", esperado="escalar", municipio="candelaria",
    nota="Candelaria queda fuera del área que busca el bot: no se ubica, decide la central.")
add("trampa-06", "otro", "trampa", "Cra 28 # 30-10 Palmira", esperado="escalar", municipio="palmira",
    nota="Palmira queda fuera del área que busca el bot.")
add("trampa-07", "sur", "trampa", "Cra 122 # 18-50 Vía Cali - Jamundí, Pance", esperado="cualquiera", municipio="cali",
    nota="Nombra Jamundí, pero es la vía dentro de Cali.")
add("trampa-08", "sur", "incompleta", "la 42 con 83", esperado="escalar", dudosa=True,
    nota="Sin tipo de vía ni placa: no hay un punto.")
add("trampa-09", "sur", "incompleta", "42 # 83-15", esperado="cualquiera", dudosa=True,
    nota="Sin tipo de vía: el bot la marca como dudosa y la confirma con el restaurante antes de cotizar.")
add("trampa-10", "sur", "incompleta", "Cra 86", esperado="escalar", nota="Solo la vía (ficha de Chilitos sin placa).")
add("trampa-11", "sur", "incompleta", "Cra 84A, El Ingenio", esperado="escalar", nota="Vía y barrio sin placa.")
add("trampa-12", "sur", "incompleta", "760004, Cali", esperado="escalar", dudosa=True, nota="Solo el código postal (ficha de Insanne Burguer).")
for n, barrio in enumerate(["Valle del Lili", "Ciudad Jardín", "Bochalema", "Ciudad Pacífica", "Capri"], 13):
    add(f"trampa-{n:02d}", "sur", "solo-barrio", barrio, esperado="escalar",
        nota="Solo el barrio: el centro de un barrio no es una puerta; la central pide la dirección.")
add("trampa-18", "jamundi", "solo-barrio", "Alfaguara, Jamundí", esperado="escalar", municipio="jamundi")
add("trampa-19", "sur", "incompleta", "Cra 98 # 42", esperado="escalar", nota="Vía y cruce sin placa: una cuadra entera.")

# --- Lugares conocidos y otras zonas de la ciudad: la dirección y el lugar
# son públicos, pero el punto todavía no está verificado en Google Maps.
LUGARES = [
    ("norte", "lugar", "Centro Comercial Chipichape"),
    ("norte", "estandar", "Cl 38 Norte # 6N-35"),
    ("sur", "lugar", "Unicentro Cali"),
    ("sur", "estandar", "Cra 100 # 5-169"),
    ("sur", "lugar", "Clínica Valle del Lili"),
    ("sur", "lugar", "Centro Comercial Jardín Plaza"),
    ("sur", "lugar", "Pontificia Universidad Javeriana Cali"),
    ("sur", "lugar", "Universidad del Valle sede Meléndez"),
    ("oeste", "lugar", "Zoológico de Cali"),
    ("centro", "lugar", "Iglesia La Ermita"),
    ("centro", "lugar", "Estadio Pascual Guerrero"),
    ("centro", "lugar", "Hospital Universitario del Valle"),
    ("centro", "estandar", "Cl 5 # 36-08, San Fernando"),
    ("oriente", "lugar", "Centro Comercial Único Outlet"),
    ("jamundi", "lugar", "Parque principal de Jamundí"),
    ("yumbo", "lugar", "Parque Belalcázar, Yumbo"),
]
for n, (zona, tipo, texto) in enumerate(LUGARES, 1):
    municipio = zona if zona in ("jamundi", "yumbo") else "cali"
    add(f"por-verificar-{n:02d}", zona, tipo, texto, municipio=municipio,
        nota="Falta el punto: buscarlo en Google Maps, comprobar el pin en el mapa y cargarlo con direcciones:referencia.")

doc = {
    "descripcion": "Direcciones reales para medir qué tan bien ubica el bot una entrega (docs/DIRECCIONES-Y-ZONAS.md, «Precisión de las direcciones»).",
    "campos": {
        "texto": "Lo que escribe el restaurante.",
        "direccion": "Lo que debe quedar en direccionEntrega después de leer el mensaje (sin torre, apto ni indicaciones). Si falta, es el texto.",
        "detalle": "La puerta, que va aparte (detalleDireccion).",
        "esperado": "ubicar: tiene un punto y el bot debe darlo. escalar: no hay un punto y no debe inventarlo. cualquiera: puede ubicarla o pasarla a la central, pero nunca fuera de su municipio.",
        "municipio": "Dónde queda de verdad: cali, jamundi, yumbo, candelaria o palmira.",
        "dudosa": "El bot la confirma con el restaurante antes de cotizar (ambiguousAddress).",
        "referencia": "El punto real, verificado en Google Maps. null: falta verificarlo; ese caso no entra en el porcentaje.",
    },
    "casos": casos,
}
with open(salida, "w", encoding="utf-8") as f:
    json.dump(doc, f, ensure_ascii=False, indent=2)
    f.write("\n")
print(len(casos), "casos;", sum(1 for c in casos if c["referencia"]), "con referencia")

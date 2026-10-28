# Casos de prueba

Cada archivo `.json` de esta carpeta es un **caso de prueba**: una situación con motos y pedidos, y qué moto debería ganar cada pedido y por qué.

Sirven para:
- **entender** por qué el algoritmo elige cada moto;
- **detectar cambios**: si se modifica un peso o una fórmula, se corren todos los casos y se ve cuáles cambiaron de resultado.

---

## Cómo correrlos

**Desde la consola**, en la carpeta `apps/engine`:

```
python3 casos.py                    # todos los casos
python3 casos.py casos/05-*.json    # solo algunos
python3 casos.py --detalle          # con el ranking completo de cada pedido
python3 -m unittest discover -s tests   # los casos y las pruebas del contrato
```

Cada pedido se evalúa con la misma petición que mandará el bot (`POST /evaluar`), así que los casos prueban también el contrato.

Al final muestra cuántos pedidos dieron lo esperado y cuáles fallaron.

**En el simulador** (por ahora en `algoritmoDeli`): en "Casos de prueba", elige un caso y presiona **Cargar**. Se ubican las motos y los pedidos en el mapa y se marca **"Ignorar motos GPS reales"**, para que tu moto real no afecte el resultado. Cada pedido muestra el resultado esperado, con ✅ o ❌ cuando se asigna.

---

## Cómo crear un caso

### Opción 1: desde el mapa

1. Arma la situación con clics: motos simuladas, pedidos con su restaurante y su cliente. Asigna pedidos si quieres que algunas motos ya vayan ocupadas.
2. Presiona **💾 Guardar lo actual como caso** y escribe un nombre y una descripción.
3. Al final te pregunta si quieres guardar el resultado actual como "esperado":
   - **Aceptar:** el caso recuerda qué moto gana hoy cada pedido. Si en el futuro cambia algo del algoritmo y ese resultado cambia, el caso fallará y te avisará. Revisa bien que el resultado de hoy sea el correcto antes de aceptar.
   - **Cancelar:** se guarda sin esperado y lo puedes agregar a mano.

Al guardar:
- los pedidos **pendientes** quedan como pedidos nuevos del caso;
- los **asignados** quedan como "pedidos en curso" de su moto;
- tu moto GPS real también se guarda, como moto simulada en su posición actual, salvo que esté marcado "Ignorar motos GPS reales".

### Opción 2: escribir el archivo a mano

Copia un caso existente y cámbialo. El formato es este:

```json
{
  "nombre": "Nombre corto del caso",
  "descripcion": "Qué situación muestra y qué se quiere comprobar.",
  "config": {
    "modo": "pico",
    "radio": 3,
    "multi": true,
    "motor": "haversine"
  },
  "motos": [
    {
      "id": "Ana",
      "lat": 3.3604, "lon": -76.5240,
      "entregas": 3,
      "min_sin_pedido": 10,
      "pedidos_en_curso": [
        {
          "restaurante": [3.3460, -76.5240],
          "cliente": [3.3730, -76.5186],
          "listo_en": 0,
          "recogido": true
        }
      ]
    }
  ],
  "pedidos": [
    {
      "nombre": "Restaurante A → cliente norte",
      "restaurante": [3.3550, -76.5240],
      "cliente": [3.3649, -76.5204],
      "listo_en": 5
    }
  ],
  "esperado": [
    { "pedido": 1, "moto": "Ana", "por": "Explicación de por qué debería ganar" }
  ]
}
```

| Campo | Qué es |
|---|---|
| `config.modo` | `"pico"`, `"valle"` o `"auto"` (pico de 7:00 a 9:30 p.m., hora de Cali). Desde la consola los casos corren a una hora fija, un martes a las 3:00 p.m., así que `"auto"` da valle; conviene fijar el modo |
| `config.radio` | Radio de búsqueda en km |
| `config.multi` | `true` si una moto puede llevar varios pedidos a la vez (hasta 3 en pico y 2 en valle) |
| `config.motor` | `"haversine"` (línea recta) u `"osrm"` (calles reales; solo en el simulador) |
| `motos[].entregas` | Entregas que lleva hoy |
| `motos[].min_sin_pedido` | Minutos desde su última entrega o desde que se conectó, lo más reciente (para la equidad) |
| `motos[].cuota` | Opcional. Cuota justa acumulada en el turno (especificaciones.md, 4.A). Si falta, se usa el promedio de entregas del grupo, que equivale a que todas lleven conectadas todo el turno |
| `motos[].pedidos_en_curso` | Pedidos que ya lleva. `recogido: false` significa que todavía tiene que pasar por el restaurante. `cliente_no_contesta_hace: 4` significa que la moto está donde el cliente, que no contesta hace 4 minutos (le quedan 6 de espera antes de devolver el pedido). En ese caso, la posición de la moto debe ser la del cliente. |
| `pedidos[]` | Pedidos nuevos, en el **orden en que llegan**. Se numeran 1, 2, 3… |
| `pedidos[].listo_en` | Minutos que faltan para que la comida esté lista |
| `esperado[].pedido` | Número del pedido (1 = el primero de la lista `pedidos`) |
| `esperado[].moto` | Moto que debería ganar, o `null` si ninguna debería ser elegible |
| `esperado[].por` | Por qué; es solo para leerlo, no se verifica |

**Para sacar coordenadas:** en Google Maps, clic derecho sobre un punto y la primera línea son la latitud y la longitud. Otra forma es armar la situación en el simulador y guardarla con la opción 1.

**Ten en cuenta:**
- Los pedidos que las motos ya llevan se numeran desde 101, y en las rutas aparecen como `#101`, `#102`…
- Desde la consola, los casos siempre usan línea recta (Haversine), para que el resultado no dependa de internet. El simulador sí puede usar OSRM.
- Desde la consola, los pedidos se asignan uno tras otro **evaluados como en su momento de despacho** (asignación diferida). El reporte indica cuántos minutos después de llegar se asignaría cada uno.
- Un caso que falla **no siempre es un error del algoritmo**: puede que la expectativa estuviera equivocada. Pasó con el caso 10, que esperaba la moto más cercana, pero la comida tardaba 5 minutos y ganó la que llegaba justo a tiempo. Antes de corregir el algoritmo, revisa que lo esperado tenga sentido.

---

## Casos incluidos

| Caso | Qué muestra |
|---|---|
| 01 | Con la comida lista, gana la moto más cercana |
| 02 | Con la comida en preparación, la asignación diferida hace ganar a la más cercana (antes ganaba la más lejana) |
| 03 | Hora pico: gana la rápida, aunque lleve más entregas |
| 04 | La misma situación en hora valle: gana la equidad |
| 05 | Agrupar: el pedido nuevo le queda de camino a una moto ocupada |
| 06 | No agrupar: el desvío es demasiado grande y gana una libre |
| 07 | Una moto con 3 pedidos queda excluida por capacidad en hora pico |
| 08 | El caso 05 sin permitir varios pedidos: la moto ocupada queda excluida |
| 09 | Ninguna moto dentro del radio: el pedido queda sin asignar |
| 10 | Dos pedidos seguidos del mismo restaurante van a la misma moto |
| 11 | Hora pico con 4 pedidos de 3 restaurantes, asignados en orden |
| 12 | Regla del cliente en hora pico: aviso con 22 min de anticipación; gana la más cercana unos 18 min después |
| 13 | Hora pico: una moto que ya va por 2 pedidos recoge un tercero del mismo restaurante |
| 14 | La misma situación en hora valle: con máximo 2 pedidos, la moto queda excluida |
| 15 | Cliente que no contesta: la moto no recibe pedidos nuevos, ni siquiera uno del restaurante al que tiene que volver (regla provisional; pendiente de definir la reasignación) |
| 16 | Cliente que no contesta: aunque la moto está al lado de otro restaurante, queda excluida y gana otra |

# Para revisar con el equipo — 2026-10-28

Tres temas de la lista de cambios que no se tocaron en el código porque hay que
decidirlos juntos: la lentitud del portal (punto 0), las tarjetas de Despachos
(punto 3) y las de Flota (punto 5). Al final, lo que falta para que la tarifa por
kilómetros (punto 7) funcione de verdad.

---

## 0. Por qué el portal se siente lento

**Resumen:** hay causas claras en el código, y hay sospechas en el servidor que
solo se confirman mirando Vercel y Neon. No se pudo medir el sitio en vivo: las
direcciones que están en la documentación (`clapi-dispatch-portal.vercel.app`,
`clapi-dispatch-bot.vercel.app`) responden `DEPLOYMENT_NOT_FOUND`. Hace falta la
URL real del portal para medir.

### 0.1 Causas en el código (confirmadas leyendo el código)

| # | Qué pasa | Dónde | Peso |
|---|---|---|---|
| 1 | **`/api/trips` devuelve todos los viajes de la historia**, sin filtro de fecha ni límite. Se vuelve a descargar entero cada 3 s, y crece cada día. La columna "Entregados" muestra todo lo entregado desde siempre, no solo lo de hoy. | `apps/portal/src/db/queries/trips.ts` → `listTrips` | Alto, y empeora con el tiempo |
| 2 | **Cada sondeo son dos llamadas al servidor en fila:** primero `POST /api/dispatch/auto-assign` y, cuando termina, `GET /api/trips`. Cada pestaña abierta hace esto cada 3 s. | `components/TripsProvider.tsx` → `refresh` | Alto |
| 3 | **Conversaciones hace tres sondeos a la vez:** viajes (3 s), lista de chats (2,5 s) e hilo abierto (2 s). La lista trae 100 conversaciones + los últimos 500 mensajes + la flota en cada vuelta. El hilo se descarga **completo** cada 2 s. | `conversaciones/page.tsx`, `db/queries/conversations.ts` | Medio-alto |
| 4 | **Los sondeos siguen con la pestaña en segundo plano.** Un computador con el portal abierto y minimizado sigue pidiendo datos. | `lib/use-polling.ts` | Medio |
| 5 | **Cada tarjeta de viaje tiene su propio reloj de 1 s.** Con muchas tarjetas (y por el punto 1 hay cada vez más) el navegador redibuja todas cada segundo, con animaciones. En celulares se nota. | `components/TripCard.tsx` → `useNow(1000)` | Medio en celular |
| 6 | Guardar tarifas por zona hace una consulta por celda, una tras otra. | `packages/shared/src/db/fares.ts` → `saveFareMatrix` | Bajo (solo al guardar) |

### 0.2 Sospechas en el servidor (hay que mirar los paneles)

- **Región de Vercel contra región de Neon.** Las funciones de Vercel corren por
  defecto en Washington (`iad1`). Si la base de Neon está en otra región (São
  Paulo, Europa), cada consulta suma de 100 a 150 ms o más, y una sola llamada
  hace varias consultas. *Revisar:* Vercel → proyecto del portal → Settings →
  Functions → Region; Neon → Project settings → Region. Deben coincidir.
- **Neon se duerme.** En el plan gratuito la base se suspende tras unos minutos
  sin uso, y la primera consulta al despertar tarda de medio segundo a varios
  segundos. *Revisar:* Neon → Compute → Scale to zero / Autosuspend.
- **Arranque en frío de Vercel.** La primera llamada a una función que llevaba
  rato quieta tarda más. *Revisar:* Vercel → Logs / Observability, duración de
  `/api/trips` y `/api/dispatch/auto-assign`.
- **Neon por HTTP:** cada consulta es una petición HTTPS aparte. Asignar un
  viaje hace varias en fila, así que la distancia a la base pesa mucho.

### 0.3 Cómo medirlo (10 minutos)

1. Abrir el portal en producción → DevTools → Network → filtrar `api`.
2. Mirar el *Waiting (TTFB)* de `/api/trips`, `/api/dispatch/auto-assign` y
   `/api/conversations`. Si pasa de unos 300 ms con la base despierta, apunta a
   la región. Si solo la primera es lenta, apunta a Neon dormido o al arranque
   en frío.
3. Mirar el tamaño de `/api/trips`. Si pesa decenas de KB y crece, es el punto 1.

### 0.4 Arreglos propuestos (sin aplicar, a decidir)

- `listTrips`: traer solo los pendientes, los que van en ruta y los entregados
  **de hoy**. Es el arreglo más barato y el que más ayuda.
- Pedir asignación y viajes en paralelo, o dejar de pedir la asignación desde
  el navegador: que la haga el servidor cuando se entrega un viaje (ya lo hace
  `completeTrip`) o una tarea programada.
- Pausar los sondeos con la pestaña oculta (`document.visibilityState`).
- Hilo de chat: pedir solo los mensajes nuevos (`?after=<último id>`).
- Un solo reloj compartido para todas las tarjetas, no uno por tarjeta.
- Poner Vercel y Neon en la misma región.

---

## 3. Despachos: tarjetas más livianas

**Problema:** hoy cada tarjeta muestra el código, el cronómetro, la recogida, la
entrega completa, el domicilio con zonas, el cobro, el teléfono del cliente y el
motorizado con dos botones. Con muchos viajes cansa la vista y obliga a hacer
scroll.

**Propuesta: tarjeta corta, y el detalle al tocarla.**

Lo que se ve siempre (dos o tres líneas):

```
DSP-0142                         ⏱ 04:12
Donde Lucho → Valle del Lili, Cl 18 #…
💵 Cobrar $45.000          (JR) Juan R.
```

- Código y cronómetro (con el color de urgencia que ya tiene).
- Restaurante → barrio o dirección de entrega, en **una** línea cortada.
- Cómo se paga: "Cobrar $X" en amarillo si es efectivo, "Pagado" en verde si no.
- El motorizado con iniciales, o "Buscando moto…".
- En "En ruta", el botón **Entregado** a mano.

Al tocar la tarjeta (computador o celular) se abre el detalle: dirección
completa, teléfono del cliente, valor del domicilio y zonas, chat y llamada al
motorizado.

- En celular: hoja que sube desde abajo.
- En computador: la tarjeta se despliega en el sitio, o un panel lateral.

En "Entregados", una sola línea por viaje: código, restaurante, hora.

**Para decidir:**
1. ¿El barrio de entrega basta en la tarjeta corta, o la dirección completa es indispensable?
2. ¿El teléfono del cliente tiene que estar a un toque sin abrir el detalle?
3. ¿Detalle en hoja/panel, o desplegar la tarjeta en el sitio?
4. ¿Hace falta un buscador o filtro por restaurante cuando haya muchos viajes?

---

## 5. Flota: qué cambiar en la tarjeta

**Lo que sobra hoy:**
- **Turno en la cola** (el cuadro "Turno 1, 2…"): ya no aplica.
- **"Última zona":** es el barrio más cercano a la última coordenada guardada,
  de una lista fija de 9 barrios. No dice dónde está el motorizado.

**Propuesta:**

1. **Indicador de ubicación** en lugar de "Última zona":
   - 🟢 *Ubicación activa · hace 1 min*
   - 🟡 *Ubicación vieja · hace 25 min*
   - 🔴 *Sin ubicación*

   La base ya guarda `lat`, `lng` y `locationUpdatedAt` de cada motorizado: el
   indicador sale de ahí.
2. **"Ver en el mapa":** un toque abre Google Maps en su punto. Más adelante,
   un mapa con toda la flota arriba de las tarjetas.
3. **Botón "Pedir ubicación"** cuando está en rojo o amarillo: le llega un
   WhatsApp al motorizado pidiéndole que la active. Así Wilians no tiene que
   escribirle a mano.
4. Quitar el turno y dejar arriba: nombre, estado, viajes de hoy y la ubicación.

**Para decidir:**
1. **¿De dónde sale la ubicación?** Es lo primero que hay que definir. Hasta
   donde sé, la API de WhatsApp Business recibe un pin de ubicación enviado a
   mano, pero no la "ubicación en tiempo real". Para seguir al motorizado en
   vivo hace falta una app o una página web para él que mande el GPS (el
   proyecto tiene un script `dev:rider`, pero la carpeta `apps/rider` no
   existe).
2. ¿Cada cuánto debe actualizarse para contar como "activa"? (¿5 min? ¿10?)
3. El aviso "Pedir ubicación": si el motorizado no ha escrito en las últimas
   24 h, Meta solo deja enviarle una **plantilla aprobada**. Hay que crearla y
   aprobarla en Meta.
4. ¿Qué más pediría Wilians en la tarjeta? (por ejemplo: dinero en efectivo que
   lleva encima, hora en que empezó el turno).

---

## 7. Tarifa por kilómetros: lo que falta

**Ya está hecho:** en Tarifas, Wilians edita una tabla por rangos ("Hasta 2 km",
"De 2 a 4 km", …, "Más de X km") con un precio por rango. Se guarda en la base
(`settings`, clave `fare_ranges`), y `priceForDistance` en
`packages/shared/src/db/fares.ts` ya calcula el precio para una distancia.

**Lo que falta:** el bot todavía cobra por zona, porque no sabe cuántos km hay
entre la recogida y la entrega. Hoy las direcciones son texto y no se ubican en
el mapa. Hay que elegir cómo medir:

| Opción | Cómo | Precisión | Costo |
|---|---|---|---|
| A | Geocodificar las dos direcciones y medir la ruta en calle (Google Routes / Distance Matrix) | La mejor: km reales de recorrido | Se paga por consulta (unos 2 por pedido) |
| B | Geocodificar y medir en línea recta | Se queda corta: en ciudad la ruta suele ser 20–40 % más larga | Solo la geocodificación |
| C | Restaurantes con coordenada fija guardada + geocodificar solo la entrega | Igual que A o B, con la mitad de consultas | Menor |

Mientras se decide, la página lo dice claro ("El bot todavía cobra por zona"), y
la tabla por zonas sigue disponible, plegada, debajo de la nueva.

**Para decidir:** opción A, B o C, y qué cobrar cuando una dirección no se
logra ubicar (hoy: la tarifa por defecto).

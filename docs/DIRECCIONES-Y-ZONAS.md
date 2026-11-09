# Direcciones, precio mínimo por zona y zonas sin cobertura

## Cómo se ubica una dirección hoy

- **Dirección escrita:** se geocodifica una sola vez con Google Geocoding (`apps/bot/src/services/google/geocode.ts`), limitado a un rectángulo que va de Cali a Jamundí (sur 3.2, oeste −76.65, norte 3.6, este −76.4).
- **Pin de WhatsApp:** coordenadas exactas, sin costo.
- **Recogida:** la del restaurante registrado, sin volver a geocodificar. Si no está registrado, hoy se ubica lo que escribió como origen. **Decidido:** la recogida de un restaurante nuevo la verifica la central a mano, no Google ni Places; el flujo está por definir ([PLAN](PLAN.md) B-3).
- **Registrar restaurantes:** en el portal, menú **Restaurantes** (nombre, WhatsApp, dirección, detalle para el motorizado y coordenadas). La dirección y las coordenadas se copian de Google Maps: se busca el local por su nombre, la dirección es la de su ficha y las coordenadas salen del clic derecho sobre el pin (en el celular, manteniendo presionado). También acepta el enlace largo de Google Maps. No usa la API de Google: el punto es el que se marca, y el formulario no guarda coordenadas fuera de Cali y Jamundí.
- **Se cobra por distancia** (Haversine × 1,3, tabla de rangos por km del portal), **con un mínimo por zona de entrega** (ver «Precio mínimo por zona», abajo). Sin ubicación no hay precio.
- **Si Google no ubica la entrega, o no responde**, el bot le pregunta a la central si la dirección es válida y cuánto vale, y le dice al restaurante que ya le avisa. La central responde desde el panel de la conversación en el portal ([BOT.md](BOT.md), «La dirección»).
- **Si Google falla al ubicar la recogida de un restaurante nuevo**, el bot responde «No puedo ubicar direcciones en este momento 🙏 Ya le paso tu pedido a la central» y la conversación queda en el portal con el pedido a medio armar.
- **Ubicación simulada** para pruebas y demostraciones: `GEOCODE_SIMULADO=true` (la misma dirección siempre cae en el mismo punto de Cali). El chat de prueba la usa por defecto; `npm run bot:chat -- --google` usa Google de verdad. Nunca en producción.
- El nombre del barrio en la cotización sale de Google (o, si no lo trae, de lo que leyó el modelo). Solo es para nombrar la entrega: el mínimo por zona se decide con el punto en el mapa, no con ese nombre.
- Formato exigido (torre y apto en conjuntos, etc.): [BOT.md](BOT.md), «La dirección».

**Google:** la facturación está activa y staging geocodifica de verdad. La llave está restringida a la IP del servidor, así que desde un computador del equipo responde `REQUEST_DENIED`: en local se usa la ubicación simulada, y lo que necesite Google de verdad se prueba en el servidor. Costos: 1 geocodificación por dirección; Geocoding es SKU Essentials, 10.000 gratis al mes.

**Por medir** ([PLAN](PLAN.md) B-3): si Google ubica mejor una recogida con el nombre del restaurante delante de la dirección, o sin él. Se compara desde el servidor, mirando `location_type` (solo `ROOFTOP` o `RANGE_INTERPOLATED` cuentan) y si el punto cae en Cali.

Idea para después (no decidida): un geocodificador propio con los datos de OpenStreetMap del mapa de zonas, y Google solo cuando el propio no encuentre.

## Precio mínimo por zona

La tabla por km coincide con lo que cobra Express en casi todos los barrios, pero en algunos el cliente cobra más sin importar la distancia: Ciudad Jardín vale 10.000 saliendo de Caney o de Valle del Lili. Para eso hay **zonas con precio mínimo**.

**La regla** (`packages/shared/src/domain/price-zones.ts`, con sus pruebas):

- El precio de un domicilio es el **mayor** entre lo que da la tabla por km y el mínimo de la zona donde se **entrega**. Un domicilio a Ciudad Jardín cuesta al menos 10.000; si sale de lejos y por km da más, se cobra lo de la tabla.
- **Fuera de toda zona** se cobra exactamente lo de la tabla, como antes.
- **Zonas dentro de zonas:** si una entrega cae en dos zonas, manda la **más pequeña**, que es la más específica. Así, dentro de un barrio con mínimo se marca una parte con otro mínimo (mayor o menor) o **sin mínimo** (esa parte cobra solo por km).
- Depende **solo de dónde se entrega**, no de dónde se recoge, y es igual para todos los restaurantes.
- Las zonas son un **área del mapa**, no el nombre del barrio que devuelve Google (Google no conoce los límites y a veces se equivoca de barrio). Por eso sale igual con **pin** o con **dirección escrita**: las dos dan un punto, y el restaurante no tiene que decir el barrio.
- El restaurante solo ve el **precio final**, como siempre.
- Las zonas se leen en **cada cotización** (`quoteByDistance`, `packages/shared/src/db/quote.ts`): un cambio de zona o de mínimo aplica desde la siguiente, sin redesplegar. Un pedido ya confirmado conserva su precio. El simulador cotiza con la misma función.
- Si la tabla por km está vacía no hay precio, haya zona o no: el pedido pasa a la central como siempre.
- No tiene nada que ver con las zonas sin cobertura (tabla aparte, mapa aparte).

**Dónde se guardan:** tabla `price_zones` (nombre, `min_price` en pesos o vacío para «sin mínimo», el contorno en `ring` y, si salió de un barrio oficial, su código en `barrio_code`).

### El mapa de precios

En el portal: menú **Precio mínimo por zona** (`/precios-zona`, que abre `/zonas/precios.html` a pantalla completa, con el mismo login). Herramienta de computador, como el de cobertura.

- **Buscar un barrio** por su nombre («Ciudad Jardín», «El Ingenio»): el mapa lo muestra con su límite oficial. **Volverlo zona** lo convierte en una zona con ese contorno, sin dibujar; solo falta el mínimo. También se puede tocar un barrio directamente en el mapa.
- **Dibujar zona:** clic en cada esquina y **Terminar**, para lo que no es un barrio (Cañasgordas, que la capa oficial no trae como barrio; Jamundí; una parte de un barrio).
- **Editar:** tocar una zona (en el mapa o en la lista). Se arrastran las esquinas para mover el borde, se toca un punto pequeño entre dos esquinas para agregar una, y clic derecho sobre una esquina la quita. Se cambia el nombre o el mínimo, o se marca **Sin mínimo**. **Eliminar zona** pide confirmación.
- **Probar una dirección:** se escribe como la mandaría el restaurante y el portal la ubica igual que el bot (le pide la ubicación al bot, `POST /api/internal/geocode`, con el mismo Google). Muestra el punto, la zona que manda con su mínimo y las otras zonas donde también cae. **Probar un punto** hace lo mismo con un clic en el mapa. Como la llave de Google solo funciona desde el servidor, en local la dirección cae en el punto simulado (`GEOCODE_SIMULADO=true`).
- Cada cambio se guarda al momento (`/api/zonas-precio`) y la lista se vuelve a leer cada 20 s.
- Los barrios cargados **no cobran nada** por sí solos: solo ayudan a crear zonas.

### Los barrios oficiales

`apps/portal/public/zonas/barrios.json`: los **342 barrios y sectores** de la DIVIPOLA de Cali (Acuerdo 0636 de 2026), de la capa `dapm:pdt_dpa_barrios_sectores` de la IDESC. Cada uno con su código, nombre, comuna y un solo contorno (el de su parte más grande, sin huecos), simplificado a unos 2 m para que se pueda editar.

La capa oficial viene en MAGNA-SIRGAS origen Cali; no hace falta convertir el shapefile: el servicio WFS del GeoServer de la IDESC la entrega en latitud y longitud (`srsName=EPSG:4326`). Para actualizarla:

```bash
python3 tools/barrios-cali/descargar.py apps/portal/public/zonas/barrios.json
```

Solo usa la librería estándar de Python. Las zonas ya guardadas no cambian al actualizar los barrios: son una copia del contorno.

No trae Jamundí (la capa es solo de Cali): allá las zonas se dibujan a mano.

## Zonas sin cobertura

Lugares adonde la agencia no entra (ni a recoger ni a entregar). Decisiones del cliente:

- **Permanentes** y **las mismas para todos los restaurantes**.
- Aplican a **recogida y entrega**.
- Dentro de una zona, el bot responde: «Qué pena, pero hasta esa dirección no manejamos domicilio».
- **Franja gris de 100 m** alrededor de cada zona: el pedido queda en espera y se le pregunta a William **en el portal** (aviso con sonido y botones **Sí / No**). «No» cancela el pedido; «Sí» sigue el flujo normal.

### El mapa para marcarlas

En el portal: menú **Zonas sin cobertura** (`/zonas`, que abre `/zonas/mapa.html` a pantalla completa). Pide el mismo login del portal; es una herramienta de computador (no sale en la barra del celular).

- Se dibujan, editan y borran zonas con el mouse; buscador de barrios; nombre de la calle y el barrio bajo el cursor; «Probar una dirección» (dentro / franja gris / fuera); «Copiar zonas (GeoJSON)» como respaldo.
- **Cada cambio se guarda al momento** en la tabla `restricted_zones` (`/api/zonas`). Se puede cerrar y seguir otro día, desde cualquier computador; la lista se vuelve a leer cada 20 s y al volver a la pestaña.
- Archivos: `apps/portal/public/zonas/mapa.html` y `cali.json` (calles y barrios de OpenStreetMap, 15 de julio de 2026; los de Jamundí dicen «· Jamundí»).
- Primera versión: una página aparte que guardaba en su propia base. Ya no se usa.

**Herramientas para regenerar las calles:** `tools/mapa-zonas/`

| Archivo | Qué es |
|---|---|
| `index.html` | La primera versión, que guardaba en su propia base; la del portal es `apps/portal/public/zonas/mapa.html` |
| `cali.json` | Vías y barrios empaquetados (~1 MB) |
| `descargar.sh` | Baja de OpenStreetMap (Overpass) las vías y barrios de Cali y Jamundí |
| `empaquetar.py` | Los convierte en `cali.json`: `python3 empaquetar.py osm-raw cali.json` |

Para actualizar las calles: `./descargar.sh osm-raw && python3 empaquetar.py osm-raw cali.json`, y copiar el nuevo `cali.json` a `apps/portal/public/zonas/`.

### Por construir ([PLAN](PLAN.md) B-4)

Hoy las zonas se guardan pero el bot no las consulta.

1. ~~Tabla `restricted_zones` y mapa en el portal.~~ Hecho.
2. En `order.ts`, después de ubicar la entrega (y con la recogida del restaurante): punto dentro de un polígono → mensaje de no cobertura; a menos de 100 m del borde → franja gris.
3. Franja gris: el pedido queda en espera y le aparece a William en el portal con Sí / No (ver las alertas en [INTERVENCION-MANUAL.md](INTERVENCION-MANUAL.md)); al restaurante, «Déjame confirmar si llegamos hasta allá».
4. Sin coordenadas no hay revisión posible, pero tampoco precio: el pedido ya pasa a la central.

# Direcciones y zonas sin cobertura

## Cómo se ubica una dirección hoy

- **Dirección escrita:** se geocodifica una sola vez con Google Geocoding (`apps/bot/src/services/google/geocode.ts`), limitado a un rectángulo que va de Cali a Jamundí (sur 3.2, oeste −76.65, norte 3.6, este −76.4).
- **Pin de WhatsApp:** coordenadas exactas, sin costo.
- **Recogida:** la del restaurante registrado, sin volver a geocodificar. Si no está registrado, hoy se ubica lo que escribió como origen. **Decidido:** la recogida de un restaurante nuevo la verifica la central a mano, no Google ni Places; el flujo está por definir ([PLAN](PLAN.md) B-3).
- **Registrar restaurantes:** en el portal, menú **Restaurantes** (nombre, WhatsApp, dirección, detalle para el motorizado y coordenadas). La dirección y las coordenadas se copian de Google Maps: se busca el local por su nombre, la dirección es la de su ficha y las coordenadas salen del clic derecho sobre el pin (en el celular, manteniendo presionado). También acepta el enlace largo de Google Maps. No usa la API de Google: el punto es el que se marca, y el formulario no guarda coordenadas fuera de Cali y Jamundí.
- **Se cobra solo por distancia** (Haversine × 1,3, tabla de rangos por km del portal). El cobro por zonas se eliminó: sin ubicación no hay precio.
- **Si Google no ubica la entrega, o no responde**, el bot le pregunta a la central si la dirección es válida y cuánto vale, y le dice al restaurante que ya le avisa. La central responde desde el panel de la conversación en el portal ([BOT.md](BOT.md), «La dirección»).
- **Si Google falla al ubicar la recogida de un restaurante nuevo**, el bot responde «No puedo ubicar direcciones en este momento 🙏 Ya le paso tu pedido a la central» y la conversación queda en el portal con el pedido a medio armar.
- **Ubicación simulada** para pruebas y demostraciones: `GEOCODE_SIMULADO=true` (la misma dirección siempre cae en el mismo punto de Cali). El chat de prueba la usa por defecto; `npm run bot:chat -- --google` usa Google de verdad. Nunca en producción.
- El nombre del barrio en la cotización sale de Google (o, si no lo trae, de lo que leyó el modelo).
- Formato exigido (torre y apto en conjuntos, etc.): [BOT.md](BOT.md), «La dirección».

**Google:** la facturación está activa y staging geocodifica de verdad. La llave está restringida a la IP del servidor, así que desde un computador del equipo responde `REQUEST_DENIED`: en local se usa la ubicación simulada, y lo que necesite Google de verdad se prueba en el servidor. Costos: 1 geocodificación por dirección; Geocoding es SKU Essentials, 10.000 gratis al mes.

**Por medir** ([PLAN](PLAN.md) B-3): si Google ubica mejor una recogida con el nombre del restaurante delante de la dirección, o sin él. Se compara desde el servidor, mirando `location_type` (solo `ROOFTOP` o `RANGE_INTERPOLATED` cuentan) y si el punto cae en Cali.

Idea para después (no decidida): un geocodificador propio con los datos de OpenStreetMap del mapa de zonas, y Google solo cuando el propio no encuentre.

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

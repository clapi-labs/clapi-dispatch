# Direcciones y zonas sin cobertura

## Cómo se ubica una dirección hoy

- **Dirección escrita:** se geocodifica una sola vez con Google Geocoding (`apps/bot/src/services/google/geocode.ts`), limitado a un rectángulo que va de Cali a Jamundí (sur 3.2, oeste −76.65, norte 3.6, este −76.4).
- **Pin de WhatsApp:** coordenadas exactas, sin costo.
- **Con coordenadas** se cotiza por distancia (Haversine × 1,3, tabla de rangos por km). **Sin ellas** (Google falla o sin facturación) se cotiza por zona, adivinada por palabras del barrio: menos precisa.
- Formato exigido (torre y apto en conjuntos, etc.): [BOT.md](BOT.md), «La dirección».

**Pendiente: Google.** La cuenta tiene la facturación apagada (`REQUEST_DENIED: You must enable Billing`). Mientras tanto todo sale por zona. Costos: 1 geocodificación por pedido; Geocoding es SKU Essentials, 10.000 gratis al mes.

Idea para después (no decidida): un geocodificador propio con los datos de OpenStreetMap del mapa de zonas, y Google solo cuando el propio no encuentre.

## Zonas sin cobertura

Lugares adonde la agencia no entra (ni a recoger ni a entregar). Decisiones del cliente:

- **Permanentes** y **las mismas para todos los restaurantes**.
- Aplican a **recogida y entrega**.
- Dentro de una zona, el bot responde: «Qué pena, pero hasta esa dirección no manejamos domicilio».
- **Franja gris de 100 m** alrededor de cada zona: el bot le pregunta a William por WhatsApp con botones **Sí / No**. «No» cancela el pedido; «Sí» sigue el flujo normal.

### El mapa para marcarlas

**https://claude.ai/artifact/FFPHcTXMW1cczECXsEEVqZ** («Zonas sin cobertura · Cali y Jamundí»)

- Se dibujan, editan y borran zonas con el mouse; buscador de barrios; nombre de la calle y el barrio bajo el cursor; «Probar una dirección» (dentro / franja gris / fuera); «Copiar zonas (GeoJSON)» como respaldo.
- Las zonas se guardan en la base de datos del artifact, colección `zonas`: `{ name, note, kind: "sin_cobertura", ring: [{lat, lng}], updatedAt }`. Desde aquí se leen con la herramienta de datos del artifact; no hace falta exportar.
- Es privado: para que el cliente marque, hay que compartirlo con permiso de edición (Share).
- Calles y barrios de OpenStreetMap (descarga del 15 de julio de 2026). Los barrios de Jamundí dicen «· Jamundí».

**Copia en el repo:** `tools/mapa-zonas/`

| Archivo | Qué es |
|---|---|
| `index.html` | El mapa (Leaflet). Fuera de claude.ai no guarda: usa la base del artifact (`claude.use("db")`) |
| `cali.json` | Vías y barrios empaquetados (~1 MB) |
| `descargar.sh` | Baja de OpenStreetMap (Overpass) las vías y barrios de Cali y Jamundí |
| `empaquetar.py` | Los convierte en `cali.json`: `python3 empaquetar.py osm-raw cali.json` |

Para actualizar las calles: `./descargar.sh osm-raw && python3 empaquetar.py osm-raw cali.json`, y volver a publicar el artifact con el nuevo `cali.json`.

### Por construir (cuando el cliente termine de marcar)

1. Leer la colección `zonas` y guardarla en una tabla `restricted_zones` (polígono como lista de puntos).
2. En `order.ts`, después de ubicar la entrega (y con la recogida del restaurante): punto dentro de un polígono → mensaje de no cobertura; a menos de 100 m del borde → franja gris.
3. Franja gris: mensaje a William con botones Sí / No y el pedido en espera; al restaurante, «Déjame confirmar si llegamos hasta allá». Falta **el número de WhatsApp de William**.
4. Sin coordenadas (Google apagado) no se puede revisar: el pedido sigue y el despachador lo ve en el portal.

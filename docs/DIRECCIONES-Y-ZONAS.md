# Direcciones y zonas de servicio

## Cómo se ubica una dirección hoy

- **Dirección escrita:** se geocodifica una sola vez con Google Geocoding (`apps/bot/src/services/google/geocode.ts`), limitado a un rectángulo que va de Cali a Jamundí (sur 3.2, oeste −76.65, norte 3.6, este −76.4).
- **Pin de WhatsApp:** coordenadas exactas, sin costo.
- **Recogida:** la del restaurante registrado, sin volver a geocodificar. Si no está registrado, hoy se ubica lo que escribió como origen. **Decidido:** la recogida de un restaurante nuevo la verifica la central a mano, no Google ni Places; el flujo está por definir ([PLAN](PLAN.md) B-3).
- **Registrar restaurantes:** en el portal, menú **Restaurantes** (nombre, WhatsApp, dirección, detalle para el motorizado y coordenadas). La dirección y las coordenadas se copian de Google Maps: se busca el local por su nombre, la dirección es la de su ficha y las coordenadas salen del clic derecho sobre el pin (en el celular, manteniendo presionado). También acepta el enlace largo de Google Maps. No usa la API de Google: el punto es el que se marca, y el formulario no guarda coordenadas fuera de Cali y Jamundí.
- **Se cobra solo por distancia** (Haversine × 1,3, tabla de rangos por km del portal, menú **Tarifas**). Ninguna zona cambia el precio. Sin ubicación no hay precio.
- **Si Google no ubica la entrega, o no responde**, el bot le pregunta a la central si la dirección es válida y cuánto vale, y le dice al restaurante que ya le avisa. La central responde desde el panel de la conversación en el portal ([BOT.md](BOT.md), «La dirección»).
- **Si Google falla al ubicar la recogida de un restaurante nuevo**, el bot responde «No puedo ubicar direcciones en este momento 🙏 Ya le paso tu pedido a la central» y la conversación queda en el portal con el pedido a medio armar.
- **Ubicación simulada** para pruebas y demostraciones: `GEOCODE_SIMULADO=true` (la misma dirección siempre cae en el mismo punto de Cali). El chat de prueba la usa por defecto; `npm run bot:chat -- --google` usa Google de verdad. Nunca en producción.
- El nombre del barrio en la cotización sale de Google (o, si no lo trae, de lo que leyó el modelo). Solo es para nombrar la entrega: si hay servicio se decide con el punto en el mapa, no con ese nombre.
- Formato exigido (torre y apto en conjuntos, etc.): [BOT.md](BOT.md), «La dirección».

**Google:** la facturación está activa y staging geocodifica de verdad. La llave está restringida a la IP del servidor, así que desde un computador del equipo responde `REQUEST_DENIED`: en local se usa la ubicación simulada, y lo que necesite Google de verdad se prueba en el servidor. Costos: 1 geocodificación por dirección; Geocoding es SKU Essentials, 10.000 gratis al mes.

**Por medir** ([PLAN](PLAN.md) B-3): si Google ubica mejor una recogida con el nombre del restaurante delante de la dirección, o sin él. Se compara desde el servidor, mirando `location_type` (solo `ROOFTOP` o `RANGE_INTERPOLATED` cuentan) y si el punto cae en Cali.

Idea para después (no decidida): un geocodificador propio con los datos de OpenStreetMap del mapa de zonas, y Google solo cuando el propio no encuentre.

## Zonas de servicio

La central marca en el mapa **solo las zonas donde sí hay domicilio**. Lo que queda por fuera no tiene servicio. Reemplaza a las zonas sin cobertura y a las de precio mínimo, que se quitaron del todo (pantallas, rutas y tablas): marcar lo que no se cubre era al revés de como piensa la central, y el precio mínimo no le funcionó.

**Las reglas** (`packages/shared/src/domain/service-zones.ts`, con sus pruebas):

- Una zona es un **nombre y un área del mapa**. No tiene precio ni tipo.
- Cuenta **dónde se entrega**, no dónde está el restaurante, y las zonas son **las mismas para todos los restaurantes**.
- **Pueden cruzarse:** la entrega está cubierta si cae en cualquiera.
- Para una entrega hay cuatro casos (`serviceVerdictAt`):

| Caso | Dónde cae la entrega | Qué hace el bot |
|---|---|---|
| **Dentro** | En una zona (o en varias) | El pedido sigue normal |
| **Cerca** | Fuera de toda zona, a **300 m o menos** del borde de una (`NEAR_ZONE_M`) | No decide solo: pasa el pedido a la central, que dice si se hace |
| **Fuera** | Fuera y a más de 300 m de toda zona | Le dice al restaurante que no hay servicio en esa dirección y no crea el pedido |
| **Sin zonas** | No hay ninguna zona marcada | Funciona como antes, sin restringir nada |

- Las zonas son un **área del mapa**, no el nombre del barrio que devuelve Google. Por eso sale igual con **pin** o con **dirección escrita**.
- **No cambian el precio:** el domicilio se cobra solo por km.
- Lo que hace el bot en cada caso: «Zonas de servicio en el bot», abajo.

**Dónde se guardan:** tabla `service_zones` (nombre, contorno en `ring` y, si salió de un barrio, su código en `barrio_code`). Cada creación, cambio y borrado deja una copia en `service_zone_versions` (con quién lo hizo): una zona borrada o cambiada sin querer se recupera de ahí.

### Las zonas de la central no se pierden

Desde que la central empieza a marcarlas, las zonas son datos suyos:

- **Ninguna migración ni despliegue puede borrarlas ni cambiarlas.** `packages/shared/src/db/service-zones-guard.test.ts` falla si una migración posterior a la 0018 hace `DROP`, `TRUNCATE`, `DELETE`, `UPDATE`, renombra o cambia columnas de `service_zones` o `service_zone_versions` (agregar una columna sí se puede), o si algún código fuera de `db/service-zones.ts` (el seed, los scripts) las escribe.
- **Copia:** en el mapa, **Descargar copia** baja todas las zonas en un archivo GeoJSON.
- **Pasarlas a producción** (o recuperar una copia): con ese archivo, `npm run zonas:importar -- zonas-de-servicio-AAAA-MM-DD.geojson` (con `DATABASE_URL` de la base de destino). Solo agrega: nunca borra ni cambia una zona, y salta las que ya están con el mismo nombre y el mismo borde, así que se puede correr dos veces.

### El mapa de zonas

En el portal: menú **Zonas** (`/zonas`, que abre `apps/portal/public/zonas/mapa.html` a pantalla completa, con el mismo login). Sirve en el computador y en el celular: el menú sale también en la barra de abajo del celular.

- **Crear:** **Nueva zona**, y después:
  - **Desde un barrio:** buscarlo por nombre (o tocarlo en el mapa). La zona sale con el borde del barrio y su nombre, que se puede cambiar.
  - **Dibujar a mano:** tocar cada esquina en el mapa; **Terminar borde** deja de agregar esquinas al tocar el mapa. Para lo que no es un barrio: Cañasgordas, Jamundí, una parte de un barrio.
- **Nombre y Guardar.** Se puede guardar desde el panel o desde el botón **Guardar** sobre el mapa.
- **Editar el borde** (también mientras se dibuja):
  - **Mover** una esquina: arrastrarla.
  - **Meter una esquina en cualquier tramo del borde**, no solo al final: tocar el punto pequeño que hay entre dos esquinas (o arrastrarlo), o **clic derecho en el mapa → Agregar punto aquí** (en el celular, mantener presionado): la esquina va al tramo del borde más cercano a ese punto. Así, si a un lado le faltó una esquina, se mete ahí sin que salga un triángulo.
  - **Quitar** una esquina: tocarla y **Quitar esquina**; con el mouse, también clic derecho sobre ella, o la tecla Suprimir.
  - **Deshacer** (o Ctrl+Z): vuelve un paso atrás.
  - Una zona tiene de 3 a 500 esquinas.
- **Editar, renombrar o borrar una zona guardada:** tocarla, en el mapa o en la lista. **Borrar zona** pide confirmación. Cancelar con cambios sin guardar pide un segundo toque.
- **Zoom:** se acerca hasta el nivel 21 (la escala marca unos 5 m: se ve la cuadra y, donde OpenStreetMap las tiene, las casas; de 19 en adelante se amplía la imagen) y se aleja hasta el 9. Se mueve sin límite, para marcar zonas en las afueras.
- **Probar:** una dirección escrita como la mandaría el restaurante (el portal le pide la ubicación al bot, `POST /api/internal/geocode`, con el mismo Google) o **Probar un punto** con un clic. Responde **Hay servicio**, **Cerca del borde: decide la central** (con la distancia), **Sin servicio** (con la zona más cercana) o **Todavía no hay zonas** (`POST /api/zonas/probar`). Como la llave de Google solo funciona desde el servidor, en local la dirección cae en el punto simulado (`GEOCODE_SIMULADO=true`).
- Cada cambio se guarda al momento; la lista se vuelve a leer cada 20 s y al volver a la pestaña.
- Los barrios **no dan ni quitan servicio** por sí solos: solo sirven para crear zonas.

### Los barrios

`apps/portal/public/zonas/barrios.json`: **363 barrios y sectores urbanos** de Cali, cada uno con su código, nombre, de dónde salió (`fuente`) y un solo contorno (el de su parte más grande, sin huecos), simplificado a unos 2 m para que se pueda editar. Se buscan por nombre y por otros nombres (`alias`).

| Fuente | Cuántos | Código | Qué son |
|---|---|---|---|
| IDESC, capa `dapm:pdt_dpa_barrios_sectores` | 342 | el de la DIVIPOLA (`0101`…) | Los barrios y sectores del perímetro urbano (Acuerdo 0636 de 2026) |
| IDESC, capa `dapm:pdt_dpa_sectores_suelo_exp_urb` | 20 | `EXP-` y el código del sector | El suelo de expansión urbana del sur, entre Cali y Jamundí: ya es ciudad, pero no está en la DIVIPOLA |
| OpenStreetMap | 1 | `OSM-` y el número de la relación | Barrios que la central usa y no tienen borde propio en la IDESC |

**Los que se agregaron** (noviembre de 2026; la central no encontraba Cachipay, Bochalema ni Pacífico):

- **Del suelo de expansión (IDESC), con su borde oficial:** Bochalema, Cachipay, Las Vegas de Comfandi (se busca también como «Las Vegas»), Las Vegas del Lili, Ciudad Meléndez 1 y 2, El Guayabal 1 y 2, El Verdal - Gonchelandia, Andalucía, Lituania - Dalandia, Piedrachiquita, El Capricho 1 y 2, El Marañón, Marañón Bajo, Zonamérica, y tres sectores que la IDESC nombra por su plan parcial: Plan parcial 1, Planes parciales 4 y 5, y Planes parciales 6, 8 y 10.
- **De OpenStreetMap:** Ciudad Pacífica (relación 9400002), que la central llama **Pacífico** y se busca así. Queda dentro del sector Piedrachiquita.

**Cómo se buscaron los que faltaban:** se cruzaron los barrios de OpenStreetMap del área de Cali con las capas de la IDESC, por ubicación y no por nombre (los nombres cambian: «Petecuy I» y «Petecuy Primera Etapa» son el mismo). Dentro del perímetro urbano oficial (`pot_2014:bcs_lim_perimetro_urbano`) los 342 barrios lo cubren todo, salvo unos pocos retazos de 100 m. Lo que faltaba era el suelo de expansión del sur. Se dejaron por fuera:

- Los que quedan fuera del perímetro urbano y del suelo de expansión, es decir, rurales, como pide la central: Montebello, Campo Alegre, Pance y las parcelaciones del oeste (Cantaclaro, La Trinidad…). Otros que en OpenStreetMap caen un poco fuera del borde oficial ya estaban en la IDESC con su nombre: Tejares - Cristales, Patio Bonito, Alto Normandía.
- Romero: en OpenStreetMap es un solo conjunto de apartamentos (Cra. 103 # 53-26), no un barrio; queda dentro de El Guayabal 2.
- Los de Jamundí, Yumbo y Candelaria (Alfaguara, Parques de Castilla, Acopi, Juanchito…): son otros municipios. Allá las zonas se dibujan a mano.

No se dibujó ningún borde a mano: todos salen de una de las tres fuentes.

**Para actualizarlos:**

```bash
python3 tools/barrios-cali/descargar.py apps/portal/public/zonas/barrios.json
```

Solo usa la librería estándar de Python. Las capas de la IDESC vienen en MAGNA-SIRGAS origen Cali; no hace falta convertir el shapefile: el servicio WFS del GeoServer de la IDESC las entrega en latitud y longitud (`srsName=EPSG:4326`). Los de OpenStreetMap se arman con la relación completa de su API. Para agregar otro de OpenStreetMap, se pone en `OSM_BARRIOS`, en el mismo script. Las zonas ya guardadas no cambian al actualizar los barrios: son una copia del contorno.

### Zonas de servicio en el bot

**Por construir** (la Parte 2 de esta tarea, [PLAN](PLAN.md) B-4): hoy las zonas se guardan y se prueban en el mapa, pero el bot todavía no las consulta.

1. En `order.ts`, después de ubicar la entrega: dentro → normal; cerca → a la central; fuera → «no hay servicio» sin crear el pedido; sin zonas → como hoy.
2. Sin coordenadas no hay revisión posible, pero tampoco precio: el pedido ya pasa a la central.

### Las herramientas del mapa anterior

`tools/mapa-zonas/` tiene la primera versión del mapa (`index.html`, con su propio fondo de calles de OpenStreetMap en `cali.json`, y los scripts `descargar.sh` y `empaquetar.py` que lo regeneran). El portal ya no la usa.

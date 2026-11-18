# Direcciones y zonas de servicio

## Cómo se ubica una dirección hoy

- **Dirección escrita:** se geocodifica una sola vez con Google Geocoding (`apps/bot/src/services/google/geocode.ts`, con pruebas en `geocode.test.ts`), limitado a un rectángulo que va de Cali a Jamundí y Yumbo (sur 3.2, oeste −76.65, norte 3.6, este −76.4). Si no nombra otro municipio, se busca en Cali; si nombra Jamundí, Yumbo, Candelaria o Palmira (o sectores como Alfaguara o Acopi), se consulta en ese municipio sin agregar «Cali», y se descarta cualquier resultado en que Google cruce de municipio o salte a otra calle distinta de la escrita.
- **Qué resultado de Google se acepta** (`interpretGeocode`): solo uno con precisión de puerta (`ROOFTOP` o `RANGE_INTERPOLATED`) o un cruce de dos calles («Calle 42 con Carrera 85C», que Google da como centro pero es la esquina). Se descarta además:
  - el que está en una vía con otro número que la escrita («Cra 94A #42-64» para «Carrera 97 # 42-10»), aunque coincida la placa;
  - el parcial (`partial_match`) cuando el texto no trae vía y placa: con solo un nombre («Valle del Lili», «Univalle sede Meléndez») Google adivina un lugar parecido. Por eso los lugares que Google marca parcial (Unicentro, la Javeriana) pasan a la central;
  - la dirección que Google ubica en dos lugares a más de 500 m («Cl 52 # 3-29»): no se elige, decide la central.
- **La puerta va aparte, y lo decide el código** (`splitDoor` en `packages/shared/src/domain/extraction.ts`, con sus pruebas en `address-door.test.ts`): la torre, el bloque, el interior, la manzana, el apartamento, la casa, el piso, la oficina y el local salen de `direccionEntrega` completos y van a `detalleDireccion` («Unidad Reserva campestre, Torre 4 apto 803» → dirección «Unidad Reserva campestre», puerta «Torre 4 apto 803»), aunque el modelo los deje en la dirección. Una palabra sin número es un nombre y se queda («Edificio Torre Alta», «Casa Blanca»). Al mapa tampoco va nunca la puerta (`addressForMap`): con la torre y el apartamento, Google devolvía el mismo punto de Reserva Campestre pero marcado parcial, y el bot lo descartaba y escalaba el pedido.
- **Conjuntos y lugares con nombre** (`resolveGeocode`, `placeNameVariants`): si Google no encuentra un lugar que empieza con «unidad», «conjunto», «urbanización», «condominio»… («unidad de reserva campestre»), se vuelve a buscar sin el conector («unidad reserva campestre») y sin la palabra que lo anuncia («reserva campestre»), hasta 2 consultas más y solo si la primera falla. Cada forma pasa por las mismas reglas de arriba: un parcial sin vía y placa sigue sin valer, así que «Valle del Lili», «Bochalema» y «Univalle sede Meléndez» (también «Conjunto Bochalema» o «Unidad Valle del Lili») siguen pasando a la central. Una dirección con números no se reescribe.
- **Preguntar el precio a un conjunto por su nombre** («hola buenas que cuesta hasta la unidad de reserva campestre ?») es una cotización, no un mensaje confuso: el prompt lo explica con ese ejemplo y, si el modelo igual lo marca confuso o no devuelve la dirección, el código la toma del mensaje (`rescuePriceQuestion`). Antes escalaba a la central.
- **Pin de WhatsApp:** coordenadas exactas, sin costo.
- **Recogida:** la del restaurante registrado, sin volver a geocodificar. Si no está registrado, hoy se ubica lo que escribió como origen. **Decidido:** la recogida de un restaurante nuevo la verifica la central a mano, no Google ni Places; el flujo está por definir ([PLAN](PLAN.md) B-3).
- **Registrar restaurantes:** en el portal, menú **Restaurantes** (nombre, WhatsApp, dirección, detalle para el motorizado y coordenadas). La dirección y las coordenadas se copian de Google Maps: se busca el local por su nombre, la dirección es la de su ficha y las coordenadas salen del clic derecho sobre el pin (en el celular, manteniendo presionado). También acepta el enlace largo de Google Maps. No usa la API de Google: el punto es el que se marca, y el formulario no guarda coordenadas fuera de Cali y Jamundí.
- **El precio** es la tabla por km del portal (menú **Tarifas**) más el ajuste fijo de la zona de servicio donde queda la entrega. Ver «Precio del domicilio» y «Distancia por calle», abajo. Sin ubicación no hay precio.
- **Si Google no ubica la entrega, o no responde**, el bot le pregunta a la central si la dirección es válida y cuánto vale, y le dice al restaurante que ya le avisa. La central responde desde el panel de la conversación en el portal ([BOT.md](BOT.md), «La dirección»).
- **Si Google falla al ubicar la recogida de un restaurante nuevo**, el bot responde «No puedo ubicar direcciones en este momento 🙏 Ya le paso tu pedido a la central» y la conversación queda en el portal con el pedido a medio armar.
- **Ubicación simulada** para pruebas y demostraciones: `GEOCODE_SIMULADO=true` (la misma dirección siempre cae en el mismo punto de Cali). El chat de prueba la usa por defecto; `npm run bot:chat -- --google` usa Google de verdad. Nunca en producción.
- El nombre del barrio en la cotización sale de Google (o, si no lo trae, de lo que leyó el modelo). Solo es para nombrar la entrega: si hay servicio se decide con el punto en el mapa, no con ese nombre.
- Formato exigido (torre y apto en conjuntos, etc.): [BOT.md](BOT.md), «La dirección».

**Google:** la facturación está activa y staging geocodifica de verdad. La llave está restringida a la IP del servidor, así que desde un computador del equipo responde `REQUEST_DENIED`: en local se usa la ubicación simulada, y lo que necesite Google de verdad se prueba en el servidor. Costos: 1 geocodificación por dirección; Geocoding es SKU Essentials, 10.000 gratis al mes.

**Por medir** ([PLAN](PLAN.md) B-3): si Google ubica mejor una recogida con el nombre del restaurante delante de la dirección, o sin él. Se compara desde el servidor, mirando `location_type` (solo `ROOFTOP` o `RANGE_INTERPOLATED` cuentan) y si el punto cae en Cali.

Idea para después (no decidida): un geocodificador propio con los datos de OpenStreetMap del mapa de zonas, y Google solo cuando el propio no encuentre.

## Precisión de las direcciones

Qué tan bien ubica el bot una dirección escrita, medido contra **puntos reales verificados en Google Maps**, no contra lo que devuelve la misma API. Mide todo el camino: el texto que escribe el restaurante, lo que va al mapa (`geocode.ts`), el punto que acepta o rechaza y la cobertura (`coverage.ts`).

**Los casos** (`apps/bot/direcciones/casos.json`, 152):

| Tipo | Casos | Qué prueban |
|---|---|---|
| `estandar` | 53 | Direcciones completas: «Cra 97 # 45-11 local 102» (la puerta aparte), «Cl 48 Bis # 92-27», «Cl 40 # 46B-15, Mariano Ramos» |
| `coloquial` | 16 | Como llegan por WhatsApp: «cra97#45-11 loc 102», «kra 95a 42 141», «Carerra 98 # 42-55», «Cl 45 #97a-15 torre 2 apto 502», con indicaciones mezcladas |
| `esquina` | 9 | «Calle 42 con Carrera 85C»: un punto exacto sin placa |
| `lugar` | 13 | Lugares conocidos del norte, oeste, centro, oriente, Jamundí y Yumbo (Chipichape, Unicentro, La Ermita, Único…), por su nombre |
| `conjunto` | 16 | Reserva Campestre (el caso real de staging) en 10 formas: «Unidad Reserva campestre, Torre 4 Apto 803», «unidad de reserva campestre», con bloque y casa, la puerta dicha primero; otros conjuntos y edificios con puerta («Edificio Torre Alta apto 1203») |
| `variante` | 12 | La misma dirección verificada escrita de otra forma: «cra 95a #42-141», «Carrera 95 A No. 42 - 141», «CRA 83C 48A 08», «Cll 48 Bis #92-27», «KRA 85 #43-76», con piso, oficina, interior o casa |
| `tipeo` | 4 | «Carerra 97», «kra 98», «Cale 42», con torre |
| `municipio` | 4 | Jamundí, Yumbo y Candelaria, con y sin conjunto: se busca en su municipio |
| `trampa` | 14 | La misma placa en Cali y en Jamundí o Yumbo («Calle 30 #1-15 jamundi», el caso de 6256a75), Candelaria y Palmira, «Vía Cali - Jamundí»; lo genérico («Conjunto residencial», «Torre 4 apto 803» sola) y los nombres que no deben reabrirse al quitar «conjunto» o «unidad» («Conjunto Bochalema», «Unidad Valle del Lili», «Unidad de Univalle sede Meléndez») |
| `incompleta` | 5 | «la 42 con 83», «Cra 86», «760004, Cali», «Cra 84A, El Ingenio»: no hay una puerta |
| `solo-barrio` | 6 | «Valle del Lili», «Ciudad Pacífica», «Alfaguara, Jamundí»: el centro de un barrio no es una puerta |

Cada caso dice qué se espera (`ubicar`, `escalar`: no debe inventar un punto, o `cualquiera`: puede pasarla a la central pero nunca ubicarla fuera de su municipio), su municipio y, si lo tiene, su **punto verificado**:

- **Casos con `exigido`** (33): los conjuntos conocidos y las direcciones claras que **tienen** que ubicarse bien. Si uno pasa a la central, queda lejos o cae a más de 150 m de su punto, la medición sale con error, igual que con un caso grave. Los casos nuevos no tienen un punto verificado propio: las variantes de escritura reutilizan el de la dirección original (el mismo lugar, ya verificado por la central) y los conjuntos llevan un **`sector`**, los barrios de la IDESC (`barrios.json`) donde tienen que caer. El punto del bot vale si queda dentro del sector o a 1 km de su borde («Dentro del sector esperado»); más lejos es «Lejos», grave. No mide la precisión (no hay pin), solo que no salte a otro lado: cuando alguien verifique el pin de Reserva Campestre en Google Maps, se carga con `bot:direcciones:referencia` y el caso pasa a medirse por metros.
- **70 puntos verificados** salen de la hoja de restaurantes socios: la central copió cada uno del pin de Google Maps (clic derecho) al registrarlos. Son direcciones reales de la operación, todas en el sur (Valle del Lili, Caney, Ciudadela Comfandi, El Ingenio, Bochalema, Ciudad Meléndez) y una en Mariano Ramos. Se cruzaron con los bordes de la IDESC: cada punto cae en el barrio que le corresponde. Para no tener 7 casos iguales, los restaurantes con la misma dirección (Fusión Plaza, Chill Plaza) cuentan una vez.
- **16 puntos verificados a mano en Google Maps** (17 de noviembre de 2026) para el resto de la ciudad: los 13 lugares, y tres direcciones que salen de sus fichas («Cl 52 # 3-29», Único; «Cra 100 # 5-169», Unicentro; «Cl 5 # 36-08, San Fernando», el HUV). Se buscó cada lugar y se miró que el pin cayera sobre él en el mapa. En los lugares grandes (universidades, zoológico, estadio) el punto es el pin del lugar, no la portería: un error de 150 a 300 m ahí puede ser solo otra entrada, y su nota lo dice.
- Un caso sin punto verificado (`referencia: null`) se mide, pero no entra en el porcentaje hasta que alguien lo verifique y lo cargue (abajo).
- La primera versión la armó `armar-casos.py` (en la misma carpeta) con la hoja, que no se versiona porque trae los WhatsApp de los restaurantes. De ahí en adelante se edita `casos.json`.

**Cómo se juzga cada caso** (`apps/bot/src/services/google/address-bench.ts`):

| Resultado | Cuándo | ¿Grave? |
|---|---|---|
| Exacto | A **50 m** o menos del punto verificado: la puerta o la de al lado | |
| Aceptable | A **150 m** o menos: la misma cuadra o la siguiente; el precio no cambia | |
| Fallo | A más de 150 m | |
| Lejos | A más de **500 m**: otro sector; precio, zona y moto salen mal | Sí |
| Otro municipio | Una dirección de Jamundí o Yumbo que cae dentro de un barrio de Cali (bordes de la IDESC, no lo que dice Google) | Sí |
| Falso positivo | No había un punto (solo el barrio, sin placa) y el bot dio uno | Sí |
| Pasó a la central teniendo punto | La dirección existía y el bot no la ubicó: cuesta tiempo de la central, no plata | |
| Pasó a la central (bien) | No había un punto y no lo inventó | |

**El acierto** es el porcentaje de exactos y aceptables entre los casos que el bot debía ubicar y tienen punto verificado (si no la ubicó, cuenta como no acertado). El informe da además el error en metros (mediana, 90 % y máximo).

**La cobertura:** con las zonas de la base, compara dónde cae el punto del bot y dónde el real. Avisa cuando decidirían distinto: por ejemplo, el real queda a menos de 300 m del borde (decide la central) y el del bot adentro (pasa sin preguntar). Los casos al borde salen solos de las zonas que tenga cada servidor.

### Cómo se corre

**En local y en CI**, sin red, con `npm test` (`address-bench.test.ts`):
- Los casos están bien armados, cada punto verificado de Cali cae en un barrio de Cali (o a menos de 1 km, como el zoológico) y los de Jamundí y Yumbo fuera de ellos.
- Para cada caso, lo que se decide antes de llamar a Google: que busque en su municipio (sin pegarle «Cali» a una de Jamundí), que confirme con el restaurante las que no dicen el tipo de vía (`ambiguousAddress`) y que la torre o el apto no vayan al mapa: la puerta que separa el código del texto es la que dice el caso (`detalle`).
- El juicio de cada resultado (con punto verificado y con sector), el resumen y el caso de 6256a75 de punta a punta, con la respuesta de Google simulada.
- Los 10 casos de Reserva Campestre pasan por `resolveGeocode` con un Google simulado que reproduce lo de staging (el mismo punto, parcial con la torre, el apto o «de») y quedan ubicados; con ese mismo Google, las trampas siguen sin ubicarse (`address-bench-conjuntos.test.ts`, `geocode-places.test.ts`). Esas respuestas son de prueba, no de Google: la prueba de verdad es la corrida de abajo.

**Contra Google de verdad, en el servidor** (la llave solo sirve desde su IP):
```bash
/opt/dispatch/measure-addresses.sh                 # todos los casos (unas 160 geocodificaciones, dentro de las gratis)
/opt/dispatch/measure-addresses.sh --extraccion    # además lee cada texto con el modelo, como en una conversación (gasta OpenAI)
/opt/dispatch/measure-addresses.sh --solo trampa-01,coloquial-02
```
Usa la imagen de migraciones con la llave del `.env` y las zonas de esa base. No escribe en la base ni manda mensajes. Deja `informe.md` y `resultados.json` en `/opt/dispatch/mediciones/direcciones-<fecha>/` y sale con error si hay algún caso grave o algún caso exigido que no se ubique. Cada consulta es la misma que hace el bot (`resolveGeocode`): sin la puerta y, si falla, con las otras formas de nombrar el lugar; el informe dice cuando un caso se ubicó «como» otra forma. `measure-addresses.sh` no viaja con el despliegue: se copia una vez, como `deploy.sh` ([OPERACION](OPERACION.md), «Cambios en `deploy.sh`»). Desde un computador: `npm run bot:direcciones:medir`, que con la llave restringida responde que se corra en el servidor.

**Verificar un punto:** buscar el lugar en Google Maps y **comprobar en el mapa** que el pin está donde debe (la puerta, el edificio, la esquina correcta), no solo aceptar el primer resultado. `resultados.json` trae el punto que dio el bot, para comparar. Después:
```bash
npm run bot:direcciones:referencia -- lugar-01 "3.4759489, -76.5276424"   # o el enlace largo de Google Maps
```
Agregar un caso: editarlo en `casos.json`; `npm test` revisa que esté bien armado.

### Resultados

| Fecha | Dónde | Acierto | Error (mediana / 90 %) | Graves | Notas |
|---|---|---|---|---|---|
| 17 nov. 2026 | Local, sin red | — | — | — | La revisión sin red destapó que el bot pedía confirmar «cra97#45-11» (vía pegada al número) y «Carerra 98 …» (tipeo) como si no dijeran si es calle o carrera. Corregido en `ambiguousAddress`. |
| 17 nov. 2026 | Staging, antes de corregir (77 zonas) | 81,4 % (70 de 86) | 7 m / 97 m | 6 | Graves: «Valle del Lili» y «Bochalema» solos daban un punto (la clínica, un local), «Univalle sede Meléndez» caía en San Fernando, «Cl 52 # 3-29» en otro sector a 4 km (Google la ubica en dos lugares), y «Ciudad Pacífica» y «Cra 98 # 42» se esperaban sin punto. Además, «Carrera 97 # 42-10» caía en la Cra 94A. |
| 17 nov. 2026 | Staging, corregido (77 zonas) | 79,1 % (68 de 86) | 7 m / 70 m, máx. 289 m | **0** | Corregido en `geocode.ts` (reglas de arriba). Las esquinas pasaron de escalar a exactas. El acierto baja porque ahora escala lo dudoso en vez de dar un punto: 17 pasan a la central teniendo punto (abajo). Cobertura distinta de la real: 0. Con `--extraccion` (el modelo lee el texto, corrida previa al último ajuste de «kra 95a 42 141»): 77,9 %, igual que sin el modelo en esa corrida, y 0 graves. |
| 18 nov. 2026 | Local, sin red | — | — | — | #86: la puerta sale del texto por código (`splitDoor`), el mapa nunca recibe torre ni apto, los conjuntos con «unidad de…» se reintentan con otras formas del nombre, y preguntar el precio a un conjunto ya no escala. 152 casos (47 nuevos, 33 exigidos). **Falta la corrida en staging** con los casos nuevos: ahí se ve cómo responde Google de verdad a cada variante de Reserva Campestre. |

**Casos de borde conocidos** (corrida corregida):
- **«Cra 83C # 37-31»** (Don Parra): Google da un `ROOFTOP` de esa misma placa a 289 m del pin que copió la central. El único fallo; hay que revisar con la central cuál de los dos puntos es el local.
- **Lugares por nombre que pasan a la central:** Chipichape, Unicentro, la Javeriana, Univalle, el zoológico, el estadio, el HUV, Único, la Clínica Valle del Lili y el parque de Jamundí, porque Google los da parciales o como centro. Se prefiere eso a un punto inventado; los restaurantes casi siempre mandan la dirección.
- **Calicanto** («Cra 95A # 45-10», «Carrera 97 # 42-10», «Cra 96A # 42-146», «Cra 95A # 42-17»): Google responde con otra placa u otra carrera y pasan a la central.
- **«Carrera 97A con Calle 45, Calicanto»:** Google no conoce el cruce; pasa a la central.
- **«Cl 52 # 3-29»** (Único) y **«Cl 5 # 36-08, San Fernando»** (HUV): Google da la placa en dos lugares o solo como centro; pasan a la central.
- **«Ciudad Pacífica» sola:** Google tiene la ficha de la urbanización y el bot la ubica; para la IDESC ese punto cae en Piedrachiquita, el barrio de al lado. Se espera `cualquiera`.

## Precio del domicilio

El precio de un domicilio es **la tabla por km más el ajuste de la zona de la entrega** (`packages/shared/src/domain/fare.ts`, con sus pruebas en `fare.test.ts`). Los valores los pone la central desde el portal; ninguno va en el código.

**La tabla por km** (menú **Tarifas**, guardada en `settings.fare_ranges`):

- Rangos con tope: «hasta 1,5 km, 5.000; hasta 3 km, 6.000; hasta 4 km, 7.000». Cada tope incluye sus km: 4 km exactos cuestan 7.000.
- El último no tiene tope: «más de 4 km, **precio base** más **N por cada km adicional**». El km adicional se cobra **por fracción**: 4,1 km ya paga uno. Con el ejemplo y +1.000 por km: 4,1 km cuesta 8.000 y 6,2 km cuesta 7.000 + 3 × 1.000 = 10.000. Así se calculó la propuesta que reproduce lo que cobra hoy el cliente.
- Las tablas de antes, sin km adicional, siguen funcionando: el último rango es un precio fijo (`perKm` 0).

**El ajuste por zona** (`service_zones.fare_adjustment`, en pesos, 0 por defecto):

- Se edita en **Tarifas** (todas las zonas en una lista) o en el mapa de **Zonas** (al editar una zona). Puede ser negativo, para bajar una zona; tope de ±200.000.
- Cuenta la zona **de la entrega**, nunca la del restaurante. Si la entrega cae en varias zonas, la más pequeña. Cerca del borde (≤ 300 m, la central decide), la zona más cercana. Fuera, o sin zonas marcadas, no hay ajuste.
- **El total nunca baja de 0.**

**Un solo cálculo:** `quoteByDistance` (`packages/shared/src/db/quote.ts`) mide los km (`deliveryDistance`), lee la tabla y las zonas y aplica `fareBreakdown`. Lo usan el bot, «Probar un punto» de Zonas y el simulador; la tabla de ejemplos de Tarifas aplica el mismo `fareBreakdown` a km medidos con `deliveryDistance`, pero solo con el OSRM propio. Si se enciende la distancia por calle, el bot y el simulador miden con Google (respaldo OSRM); «Probar un punto» le pide la cotización al bot (`/api/internal/quote`, porque la llave de Google solo está en el bot) para dar los mismos km.

**Cuándo aplica un cambio:** desde la siguiente cotización. Los pedidos que ya tienen precio no cambian: el viaje guarda el total (`trips.delivery_fee`) y su desglose (`fare_table_price`, `fare_adjustment`, `fare_zone_name`), congelados.

**La tabla nueva se enciende junto con la distancia por calle:** está calibrada con km por calle, y con la línea recta de hoy los precios saldrían mal. Primero se cargan la tabla y los ajustes que confirme el cliente, mirando la tabla de ejemplos, y en el mismo momento se enciende `porCalle` ([OPERACION](OPERACION.md), «Mapa de calles (OSRM)»).

### Dónde se ve el desglose

- **Viajes:** al abrir la tarjeta de un pedido sale la distancia (y si es por calle), lo de la tabla, el ajuste de la zona (con su nombre) y el total. Si el precio lo puso la central, o es de antes de este cambio, dice que no tiene desglose. El restaurante sigue viendo solo el total.
- **Consulta de cobertura:** si la central dice «Sí, se hace» con el precio que calculó el bot, el viaje guarda el desglose; si pone otro precio, queda sin desglose.

### Tabla de ejemplos

Debajo de la tabla, en **Tarifas**: para cada zona de origen donde hay restaurantes y cada zona de destino, los **km típicos**, el precio de la tabla, el ajuste de la zona de destino y el total.

- **Los km** (`fareExampleDistances` en `packages/shared/src/db/fare-examples.ts`, `GET /api/fares/ejemplos`): desde cada restaurante activo de la zona de origen (la más pequeña que lo contiene) hasta el centro de la zona de destino (`zoneCenter`: su centro de masa, o el punto de adentro más cercano a él si la zona tiene forma de L). El típico es la **mediana**, y entre paréntesis el rango (mínimo–máximo). Se miden como los mide el bot: por calle si está encendido; si OSRM no responde para alguna, lo dice, y las que quedan fuera del mapa de calles no entran. Con el interruptor apagado, la casilla **Medir por calle (como quedará al encender)** mide por calle solo para esta vista previa (`?medida=calle`): así se ve la tarifa nueva antes de encenderla, sin cambiar lo que cobra el bot.
- **Los precios** se calculan en el navegador con lo que está escrito, **antes de guardar**: cambiar un precio, el km adicional o un ajuste cambia la tabla al momento. Al recargar sin guardar vuelve a lo guardado. Si la tabla por km tiene un error, los ejemplos usan la guardada.
- Un selector «Desde» filtra por zona de origen. Los restaurantes fuera de toda zona no entran (se dice cuántos).

## Distancia por calle

Con qué km se cobra el domicilio (`deliveryDistance` y `quoteByDistance` en `packages/shared/src/db/quote.ts`; el cliente de OSRM en `packages/shared/src/domain/road-distance.ts`, con sus pruebas).

**Por qué:** la línea recta × 1,3 se queda corta. Comparada con rutas reales en 1.286 trayectos (cada restaurante de staging hacia el centro de cada zona de servicio), la calle mide en el caso típico 1,55 veces la línea recta, de 1,27 a 2,14 según la ruta; en 694 trayectos (54 %) el cálculo viejo se quedaba corto por más de 0,5 km, y en el peor caso por 3,6 km. Como el error cambia de una ruta a otra, ninguna tabla lo compensa.

**Cómo funciona:**

- Con el interruptor `settings.routing_config.porCalle` **encendido**, el bot mide los km desde la recogida hasta la entrega con **Google Routes API** y, si Google no responde, con un **OSRM propio** (en el mismo servidor, con el mapa de OpenStreetMap de Cali, perfil de carro). Esos km, con un decimal, buscan el precio en la tabla de Tarifas (más el ajuste de la zona), igual que antes.
- **Modelo híbrido.** Las cotizaciones en vivo van a Google porque OSM tiene giros prohibidos que no existen en la calle y el perfil de carro prefiere vías rápidas: Salsa y Ají → Reserva Campestre da 7,2 km en Google Maps y 8,7 km en OSRM (+21 %). Lo masivo se queda en OSRM, que cuesta $0: la tabla de ejemplos de Tarifas (`fareExampleDistances` pasa `osrmRouter()`, nunca llama a Google) y los minutos del engine (`apps/engine/calles.py`).
- **Google Routes** (`packages/shared/src/domain/google-routes.ts`): `POST routes.googleapis.com/directions/v2:computeRoutes`, `DRIVE`, `TRAFFIC_UNAWARE`, `computeAlternativeRoutes`, solo `routes.distanceMeters`, tiempo límite de 1,5 s. Se toma la ruta **más corta** de las alternativas, con un decimal. Es el nivel Compute Routes Essentials (10.000 gratis al mes, luego US$ 5 por 1.000). **No** usar `TWO_WHEELER` ni `TRAFFIC_AWARE_OPTIMAL`: son de otro nivel y cuestan de 3 a 10 veces más. Las distancias **no se guardan** aparte: los Términos de Google prohíben cachearlas. Sí se guardan `trips.route_km` del viaje confirmado, y la cotización del borrador (`cotizacion`) se reutiliza mientras no cambie la recogida ni la dirección de entrega.
- **Apagado** (por defecto), todo funciona exactamente como antes: línea recta × 1,3, sin consultar OSRM. Se enciende **al mismo tiempo** que se carga la tabla de precios hecha para km por calle: con la tabla de hoy todos los precios subirían de golpe. Cómo encenderlo: [OPERACION](OPERACION.md), «Mapa de calles (OSRM)».
- **Cascada de respaldo:** Google → OSRM → línea recta × 1,3. Sin `GOOGLE_MAPS_API_KEY`, o si Google falla (4xx, 5xx, 429), tarda más de 1,5 s o responde sin ruta de carro, se mide con OSRM. Si OSRM no responde en 800 ms, o falla: línea recta × 1,3. El pedido no se frena, el restaurante no ve ningún error y la caída queda en el registro (`[calles] …`). Tras una caída de Google u OSRM no se le pregunta durante 30 s, para que las cotizaciones no esperen.
- **Si OSRM responde pero no hay ruta** (un punto a más de 500 m de toda calle del mapa, o fuera del área cargada): esa entrega **no se cotiza**, no se reemplaza por línea recta. El bot le pregunta a la central, que confirma la dirección y el valor. Lo mismo si el punto queda fuera de las zonas de servicio.
- **Se guardan con el viaje** los km con que se cotizó (`trips.route_km`) y de dónde salieron (`trips.route_source`: `google`, `calle` —OSRM— o `linea_recta`), congelados como el precio. Las distancias no se guardan aparte: medir con el OSRM local tarda pocos milisegundos.
- **El portal muestra esos mismos km**, solo el número («7,2 km»), en la tarjeta del viaje y en la consulta de cobertura («Sí, se hace») junto al precio; de dónde salieron se ve en `route_source`. Los viajes anteriores, sin `route_km`, se siguen mostrando en línea recta × 1,3.
- **El engine** mide los minutos de viaje con la misma fuente ([ALGORITMO](ALGORITMO.md), «Cómo calcula los tiempos»): precio y asignación miden igual.
- **Siguen en línea recta:** los 300 m de «cerca de una zona» (abajo), el radio del engine y el ETA que se le da al restaurante.

**Cuánto cambia** en un servidor, con sus restaurantes y zonas: `compare-distances.sh` ([OPERACION](OPERACION.md), «Mapa de calles (OSRM)»).

## Zonas de servicio

La central marca en el mapa **solo las zonas donde sí hay domicilio**. Lo que queda por fuera no tiene servicio. Reemplaza a las zonas sin cobertura y a las de precio mínimo, que se quitaron del todo (pantallas, rutas y tablas): marcar lo que no se cubre era al revés de como piensa la central, y el precio mínimo no le funcionó.

**Las reglas** (`packages/shared/src/domain/service-zones.ts`, con sus pruebas):

- Una zona es un **nombre, un área del mapa y un ajuste de precio** (0 por defecto, ver «Precio del domicilio»). No tiene tipo.
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
- **Cambian el precio solo con su ajuste:** el domicilio es la tabla por km más el ajuste de la zona de la entrega.
- Lo que hace el bot en cada caso, con los mensajes: «Zonas de servicio en el bot», abajo.

**Dónde se guardan:** tabla `service_zones` (nombre, contorno en `ring`, ajuste de precio en `fare_adjustment` y, si salió de un barrio, su código en `barrio_code`). Cada creación, cambio y borrado deja una copia en `service_zone_versions` (con quién lo hizo): una zona borrada o cambiada sin querer se recupera de ahí.

### Las zonas de la central no se pierden

Desde que la central empieza a marcarlas, las zonas son datos suyos:

- **Ninguna migración ni despliegue puede borrarlas ni cambiarlas.** `packages/shared/src/db/service-zones-guard.test.ts` falla si una migración posterior a la 0018 hace `DROP`, `TRUNCATE`, `DELETE`, `UPDATE`, renombra o cambia columnas de `service_zones` o `service_zone_versions` (agregar una columna sí se puede), o si algún código fuera de `db/service-zones.ts` (el seed, los scripts) las escribe.
- **Copia:** en el mapa, **Descargar copia** baja todas las zonas en un archivo GeoJSON, con su ajuste de precio (`fareAdjustment`), que `zonas:importar` también carga.
- **Pasarlas a producción** (o recuperar una copia): con ese archivo, `npm run zonas:importar -- zonas-de-servicio-AAAA-MM-DD.geojson` (con `DATABASE_URL` de la base de destino). Solo agrega: nunca borra ni cambia una zona, y salta las que ya están con el mismo nombre y el mismo borde, así que se puede correr dos veces.

### El mapa de zonas

En el portal: menú **Zonas** (`/zonas`, que abre `apps/portal/public/zonas/mapa.html` a pantalla completa, con el mismo login). Sirve en el computador y en el celular: el menú sale también en la barra de abajo del celular.

- **Crear:** **Nueva zona**, y después:
  - **Desde un barrio:** buscarlo por nombre (o tocarlo en el mapa). La zona sale con el borde del barrio y su nombre, que se puede cambiar.
  - **Dibujar a mano:** tocar cada esquina en el mapa; **Terminar borde** deja de agregar esquinas al tocar el mapa. Para lo que no es un barrio: Cañasgordas, Jamundí, una parte de un barrio.
- **Nombre, ajuste de precio y Guardar.** El ajuste se escribe en pesos (con un menos adelante para bajar). Se puede guardar desde el panel o desde el botón **Guardar** sobre el mapa. La lista muestra el ajuste de las zonas que tienen uno.
- **Editar el borde** (también mientras se dibuja):
  - **Mover** una esquina: arrastrarla.
  - **Meter una esquina en cualquier tramo del borde**, no solo al final: tocar el punto pequeño que hay entre dos esquinas (o arrastrarlo), o **clic derecho en el mapa → Agregar punto aquí** (en el celular, mantener presionado): la esquina va al tramo del borde más cercano a ese punto. Así, si a un lado le faltó una esquina, se mete ahí sin que salga un triángulo.
  - **Quitar** una esquina: tocarla y **Quitar esquina**; con el mouse, también clic derecho sobre ella, o la tecla Suprimir.
  - **Deshacer** (o Ctrl+Z): vuelve un paso atrás.
  - Una zona tiene de 3 a 500 esquinas.
- **Editar, renombrar o borrar una zona guardada:** tocarla, en el mapa o en la lista. **Borrar zona** pide confirmación. Cancelar con cambios sin guardar pide un segundo toque.
- **Zoom:** se acerca hasta el nivel 21 (la escala marca unos 5 m: se ve la cuadra y, donde OpenStreetMap las tiene, las casas; de 19 en adelante se amplía la imagen) y se aleja hasta el 9. Se mueve sin límite, para marcar zonas en las afueras.
- **Probar:** una dirección escrita como la mandaría el restaurante (el portal le pide la ubicación al bot, `POST /api/internal/geocode`, con el mismo Google) o **Probar un punto** con un clic. Responde **Hay servicio**, **Cerca del borde: decide la central** (con la distancia), **Sin servicio** (con la zona más cercana) o **Todavía no hay zonas** (`POST /api/zonas/probar`). Como la llave de Google solo funciona desde el servidor, en local la dirección cae en el punto simulado (`GEOCODE_SIMULADO=true`).
- **Probar desde un restaurante:** se elige un restaurante (con ubicación) arriba de «Probar una dirección», y la prueba trae además la **cotización real**, la misma de `quoteByDistance`: km, precio de la tabla, ajuste de la zona y total. Si el punto queda **fuera** de las zonas, o fuera del mapa de calles, dice que el bot no lo toma y no da precio; **cerca del borde**, da el precio y avisa que el bot se lo pregunta a la central. No crea pedidos ni manda mensajes. Escribir una dirección gasta una consulta de geocodificación; tocar el mapa no.
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

En `order.ts`, con la entrega ubicada y antes de cotizar, cada entrega sin precio pasa por `coverageAt` (`apps/bot/src/bot/coverage.ts`, con sus pruebas). Las zonas se leen en cada mensaje: una zona nueva o cambiada aplica desde el siguiente.

| Caso | Al restaurante | El pedido |
|---|---|---|
| Dentro | Lo de siempre: el precio y el botón | Sigue normal |
| Cerca (≤ 300 m del borde) | «Déjame confirmar con la central si llegamos hasta … 🙏 Te aviso en un momento.» | Queda guardado y el chat pasa a la central (consulta de cobertura) |
| Fuera | «Qué pena, pero hasta … no manejamos domicilio 🙏» | Esa entrega no se pide; si no queda ninguna, no se crea el pedido |
| Sin zonas | Lo de siempre | Sigue normal |

- **La consulta de cobertura** usa el mismo panel que la consulta de dirección (`consultaAsesor` con `motivo: "cobertura"`, motivo «Consulta de cobertura: …» en el portal). La central ve la dirección, a cuántos metros de qué zona queda, los km de la cotización (por calle, si está encendido) y lo que vale (tabla por km más el ajuste de esa zona), y responde **Sí, se hace** (con ese precio o el que ponga) o **No se hace**. El bot retoma: el pedido con el botón de confirmar, o «no manejamos domicilio» y esa entrega se quita. Lo aplica `answerAdvisorQuery` en `apps/bot/src/bot/advisor.ts`.
- Con varias entregas, cada una por su lado: las de fuera se quitan con su aviso, las de cerca van juntas en una consulta y las de dentro esperan con su precio.
- **Sin coordenadas no hay revisión:** una dirección que el mapa no ubicó y la central validó a mano no tiene punto.
- Si cambia la dirección de una entrega, se vuelve a revisar. Si cambia la recogida, también: todo se vuelve a cotizar.

### Las herramientas del mapa anterior

`tools/mapa-zonas/` tiene la primera versión del mapa (`index.html`, con su propio fondo de calles de OpenStreetMap en `cali.json`, y los scripts `descargar.sh` y `empaquetar.py` que lo regeneran). El portal ya no la usa.

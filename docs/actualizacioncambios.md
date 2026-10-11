# Actualización del portal — cambios de la rama `actualizacion-portal`

> Todo lo que cambió desde que la rama salió de `main`. Punto de partida:
> `adf6c60` (2026-10-06, "Distingue en el portal un secreto incorrecto de otros
> errores del bot"). Desde ahí son 4 commits, todos del 2026-10-11:
> 14 archivos, 638 líneas agregadas y 47 quitadas.

## 0. Resumen

| Área | Qué cambió | Commit |
|---|---|---|
| Conversaciones | Los chats se separan en restaurantes y motorizados, con pestañas, chip y color propio | `3ccf133`, `51ea9f0` |
| Teléfonos | Todo teléfono del portal se puede tocar: WhatsApp Web en computador, WhatsApp o llamada en celular | `6b3a936` |
| Despachos | La tarjeta del viaje muestra el teléfono del motorizado asignado | `6b3a936` |
| Flota | "Ver más" en cada tarjeta: viaje en curso, ritmo, vehículo y datos personales editables | `187f53a` |
| Base de datos | Tabla nueva `courier_profiles` | `187f53a` |

**Requiere una acción al desplegar:** `npm run db:push` para crear
`courier_profiles` (ver §4). Sin eso, "Ver más" en Flota muestra "No se pudo
cargar la ficha"; el resto del portal y el bot no se ven afectados.

Todo el cambio vive en `apps/portal` salvo el esquema, que está en
`packages/shared`. El bot (`apps/bot`) no se tocó.

---

## 1. Conversaciones: restaurantes y motorizados por separado

Commits `3ccf133` y `51ea9f0`.

Antes la bandeja era una sola lista y todo chat se veía como si fuera de un
restaurante. Ahora cada conversación sale marcada con su tipo.

### 1.1 Cómo se decide el tipo

En `listConversations` (`apps/portal/src/db/queries/conversations.ts`) se trae
además la flota activa y se compara el teléfono del chat contra el de cada
motorizado usando **los últimos 10 dígitos**. Es la misma regla de
`findCourier` en el bot (`apps/bot/src/bot/intake.ts`): un motorizado guardado
como `3001234567` y el `wa_id` `573001234567` de WhatsApp son la misma persona.

- Si el número está en la flota activa: `kind: "courier"` y `courierName` con
  su nombre de Flota.
- Si no: `kind: "restaurant"` y `courierName: null`.

No hay columna nueva: el tipo se calcula en cada consulta. Un motorizado que se
quita de la flota vuelve a verse como restaurante.

### 1.2 Lo que se ve

- **Pestañas** Todos, Restaurantes y Motorizados, cada una con su contador. La
  bandeja abre en Todos (`51ea9f0` la puso primera; `3ccf133` abría en
  Restaurantes).
- **Punto de aviso** amarillo en Restaurantes y en Motorizados cuando en ese
  grupo hay chats esperando a un asesor (bot pausado), aunque se esté mirando
  otra pestaña. En Todos no aparece: sobraría.
- **Chip con ícono y texto** ("Restaurante" / "Motorizado") en cada fila de la
  lista y en el encabezado del chat abierto.
- **Color por tipo** en avatar, chip, fila seleccionada y burbujas: morado de
  Clapi para restaurantes, azul para motorizados.
- **Nombre del motorizado**: se muestra el de Flota, no el de su perfil de
  WhatsApp. El orden es nombre de Flota, nombre de WhatsApp, teléfono.
- **Mensaje de bandeja vacía** distinto por pestaña.

### 1.3 Comportamiento al cambiar de pestaña

- Si el chat abierto pertenece a la pestaña nueva, se queda abierto.
- Si no, en escritorio (1024 px o más) pasa al primer chat de esa pestaña; en
  celular se cierra y queda la lista.
- La pestaña activa se guarda también en un `ref`, para que un sondeo que ya
  iba en camino no abra un chat de la pestaña anterior.

### 1.4 Color nuevo en el tema

`apps/portal/src/app/globals.css` pasa de tres a cuatro capas de color. La
nueva es la del motorizado:

| Variable | Valor | Uso |
|---|---|---|
| `--courier` | `#0369a1` | Base del chip y del avatar |
| `--courier-ink` | `#075985` | Texto sobre el tinte |
| `--courier-soft` | `#e8f4fb` | Fila seleccionada y burbuja entrante |

Quedan disponibles como `bg-courier`, `text-courier-ink` y `bg-courier-soft`.

---

## 2. Teléfonos interactivos

Commit `6b3a936`.

### 2.1 Componente `PhoneLink`

Archivo nuevo: `apps/portal/src/components/PhoneLink.tsx`. Recibe `phone`,
`name` (opcional) y `className` (opcional).

- **En computador** abre el chat de ese número en WhatsApp Web
  (`https://web.whatsapp.com/send?phone=...`) en otra pestaña.
- **En celular o tableta** sube un menú desde abajo con dos opciones:
  "Enviar WhatsApp" (`https://wa.me/...`) y "Llamar por teléfono" (`tel:+...`).
  Se cierra tocando fuera, con Escape o con "Cancelar".

Decisiones de implementación:

- Es un enlace de verdad y el dispositivo se detecta **al tocar**, no al
  pintar. Así el servidor y el navegador renderizan lo mismo, y en computador
  sigue funcionando el clic del medio o "abrir en pestaña nueva".
- El iPad se presenta como Mac, por eso además del `userAgent` se mira si la
  pantalla es táctil (`maxTouchPoints`).
- El menú se monta en un portal sobre `document.body`: las tarjetas se animan
  con `transform`, y eso encierra a un elemento `fixed` adentro.
- La zona táctil se agranda con un `after` sin mover nada de sitio.

### 2.2 Dónde se usa

| Pantalla | Teléfono | Antes |
|---|---|---|
| Despachos, tarjeta del viaje | Cliente | Enlace `tel:` armado a mano |
| Despachos, tarjeta del viaje | Motorizado asignado | No se mostraba |
| Flota, tarjeta del motorizado | Motorizado | Texto estático |
| Flota, "Ver más" | Contacto de emergencia | No existía |

Para mostrar el teléfono del motorizado en Despachos, `listTrips`
(`apps/portal/src/db/queries/trips.ts`) suma un `leftJoin` a `couriers`: la
asignación solo guarda el nombre. El tipo `Trip` gana `courierPhone`.

### 2.3 Normalización de números

En `apps/portal/src/lib/format.ts`:

- `phoneDigits(phone)` (nueva): deja solo dígitos y, si son 10 o menos, les
  antepone el `57` de Colombia. Es lo que esperan los enlaces de WhatsApp y
  `tel:`.
- `formatPhone(phone)` ahora pasa por `phoneDigits`. Efecto visible: un número
  guardado como `3001234567` se muestra como `+57 300 123 4567` en todo el
  portal, no solo los que ya traían el indicativo.

---

## 3. Flota: "Ver más"

Commit `187f53a`.

Cada tarjeta de Flota se queda en el resumen y despliega el detalle a pedido,
para que una flota grande siga siendo legible. El botón alterna "Ver más" /
"Ver menos"; la grilla usa `items-start` para que abrir una tarjeta no estire a
sus vecinas de fila.

El detalle es el componente nuevo
`apps/portal/src/components/CourierDetails.tsx`, con cuatro bloques:

| Bloque | Contenido | De dónde sale |
|---|---|---|
| Viaje en curso | Código, tiempo en la calle, restaurante de origen y dirección de entrega | Viajes que el portal ya tiene cargados (`useTrips`) |
| Ritmo | Promedio por entrega con el número de entregas, y hace cuánto recibió el último viaje | Los mismos viajes y `lastAssignedAt` del motorizado |
| Vehículo | Placa y moto (marca y modelo) | Ficha (`courier_profiles`) |
| Datos personales | Cédula, contacto de emergencia y su teléfono | Ficha (`courier_profiles`) |

Notas:

- El **promedio por entrega** es el tiempo de asignado a entregado, calculado
  sobre los viajes entregados que el portal tiene cargados en ese momento.
- La **ficha se pide al abrir** "Ver más", no en cada sondeo: una flota grande
  no carga la de todos cada vez.
- Los campos vacíos se muestran como "Sin registrar".
- **"Editar datos"** abre el formulario ahí mismo, con Guardar y Cancelar. Si
  falla la carga hay un "Reintentar"; si falla el guardado, un aviso y el
  formulario se queda abierto con lo escrito.

En `format.ts` se extrajo `durationLabel(segundos)` de `elapsedLabel`, para
poder escribir una duración que no es "desde hace".

### 3.1 API nueva

`apps/portal/src/app/api/couriers/[id]/profile/route.ts`

| Método | Hace | Respuesta |
|---|---|---|
| `GET` | Devuelve la ficha del motorizado | Los cinco campos; `null` en los que no hay dato. Un motorizado sin ficha no da error: sale todo vacío |
| `PUT` | Crea o actualiza la ficha (upsert) | La ficha guardada |

Lo que el `PUT` hace con cada campo antes de guardar:

| Campo | Tope | Tratamiento |
|---|---|---|
| `vehiclePlate` | 12 | Mayúsculas y solo letras y números: `abc 12d` y `ABC-12D` quedan `ABC12D` |
| `vehicleType` | 60 | Recortado |
| `documentId` | 20 | Recortado |
| `emergencyContactName` | 60 | Recortado |
| `emergencyContactPhone` | 20 | Recortado |

En todos, un texto vacío se guarda como `null`.

---

## 4. Base de datos

Tabla nueva en `packages/shared/src/db/schema.ts`:

```
courier_profiles
  courier_id               integer   PK, FK -> couriers.id (on delete cascade)
  vehicle_plate            text
  vehicle_type             text
  document_id              text
  emergency_contact_name   text
  emergency_contact_phone  text
  updated_at               timestamptz  not null, default now()
```

Una fila por motorizado, creada la primera vez que se guarda su ficha.

**Por qué tabla aparte y no columnas en `couriers`:** el bot y la cola leen la
fila completa de `couriers` en cada mensaje con `select()`. Una columna nueva
sin aplicar en la base tumbaría el bot. `courier_profiles` solo se consulta al
abrir "Ver más" en Flota, así que desplegar el código antes de aplicar el
esquema no rompe nada más que esa ficha.

Para aplicarla:

```
npm run db:push
```

No hay más cambios de esquema en la rama. La separación de Conversaciones
(§1) y los teléfonos (§2) no tocan la base.

---

## 5. Tipos

`apps/portal/src/lib/types.ts`:

- `Trip` gana `courierPhone: string | null`.
- `ConversationSummary` gana `kind: ConversationKind` y
  `courierName: string | null`.
- Nuevos: `ConversationKind = "restaurant" | "courier"` y `CourierProfile`.

---

## 6. Archivos tocados

| Archivo | Estado | Parte |
|---|---|---|
| `apps/portal/src/app/(dashboard)/conversaciones/page.tsx` | Modificado | §1 |
| `apps/portal/src/app/globals.css` | Modificado | §1.4 |
| `apps/portal/src/db/queries/conversations.ts` | Modificado | §1.1 |
| `apps/portal/src/components/PhoneLink.tsx` | Nuevo | §2.1 |
| `apps/portal/src/components/TripCard.tsx` | Modificado | §2.2 |
| `apps/portal/src/db/queries/trips.ts` | Modificado | §2.2 |
| `apps/portal/src/lib/format.ts` | Modificado | §2.3, §3 |
| `apps/portal/src/components/CourierCard.tsx` | Modificado | §2.2, §3 |
| `apps/portal/src/components/CourierDetails.tsx` | Nuevo | §3 |
| `apps/portal/src/app/(dashboard)/flota/page.tsx` | Modificado | §3 |
| `apps/portal/src/app/api/couriers/[id]/profile/route.ts` | Nuevo | §3.1 |
| `apps/portal/src/db/queries/couriers.ts` | Modificado | §3.1 |
| `packages/shared/src/db/schema.ts` | Modificado | §4 |
| `apps/portal/src/lib/types.ts` | Modificado | §5 |

---

## 7. Historial de la rama

| Commit | Fecha | Mensaje |
|---|---|---|
| `3ccf133` | 2026-10-11 03:06 | Separa en Conversaciones los chats de restaurantes y de motorizados |
| `51ea9f0` | 2026-10-11 03:13 | Pone primero la pestaña Todos en Conversaciones y abre en ella |
| `6b3a936` | 2026-10-11 03:25 | Teléfonos interactivos: WhatsApp Web en computador, WhatsApp o llamada en celular |
| `187f53a` | 2026-10-11 03:46 | Flota: "Ver más" con viaje en curso, ritmo, vehículo y datos personales |

## 8. Estado frente a `main`

`origin/main` tiene dos commits que esta rama todavía no trae (`7cf509d` y
`ead1d19`): documentación de despliegue en Vercel, variables de entorno y
sistema. Tocan `.gitignore`, `apps/portal/.env.example` y archivos en `docs/`,
ninguno de los que cambia esta rama.

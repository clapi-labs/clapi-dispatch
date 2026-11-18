# Conversaciones: capacidad, imágenes y carga del servidor

Informe de diagnóstico (issue #82). Solo análisis y mediciones: no se implementó nada de lo que aquí se recomienda, salvo el arreglo de la caja de texto (sección 1). Lo que sigue queda como base para issues aparte.

Qué está medido y qué no:

- **Medido:** el comportamiento de las consultas de Conversaciones con datos sintéticos, en una base Postgres 17 local y desechable (nunca contra staging ni producción).
- **No medido:** el consumo real de cada contenedor en staging. Desde esta máquina no hubo acceso SSH al servidor (`Permission denied (publickey)`), así que esa sección lleva estimaciones y el comando para completarla (sección 4).

---

## 1. Por qué se trababa escribir en Conversaciones, y qué se corrigió

**Causa.** El texto que se escribía (`draftText`) vivía en la raíz de `ConversacionesPage`. Cada tecla volvía a pintar toda la página: la lista lateral (hasta 100 chats), todas las burbujas del hilo, y en cada burbuja se recalculaban `toLocaleTimeString` y `dayLabel`. Además, un efecto sobre `draftText` ponía `height = "auto"` y leía `scrollHeight` en cada tecla, lo que obliga al navegador a recalcular el layout de forma síncrona. Con hilos largos y la bandeja llena, esas dos cosas juntas se notan.

**Corrección** (`apps/portal/src/app/(dashboard)/conversaciones/page.tsx`):

| Cambio | Efecto |
|---|---|
| `Composer`: caja de texto y envío en su propio componente, con el borrador adentro | Teclear solo repinta la caja, nunca la bandeja ni el hilo |
| `Thread` y `Bubble` memoizados; hora y etiqueta de día calculadas una vez por mensaje | Un cambio ajeno al hilo no repinta las burbujas |
| Envío optimista: la caja se vacía al presionar Enviar y el envío sigue en segundo plano, en orden | Si WhatsApp o la red tardan, la demora es del envío; la caja nunca se bloquea ni se desactiva |
| Si el envío falla, el texto vuelve a la caja (si no hay otro mensaje a medio escribir) y se muestra el error | No se pierde lo escrito |
| `loadList` y `loadThread` comparan la respuesta con la anterior y no actualizan el estado si es idéntica | Un aviso en vivo o un sondeo que trae lo mismo no repinta nada mientras se escribe |

Cambio de comportamiento: al cambiar de chat, la caja se reinicia. Antes el borrador se arrastraba de un chat a otro, y se podía enviar por error a otro contacto.

Pendiente de verificar a mano: escribir párrafos largos con un hilo largo, en escritorio y en celular. No hay prueba automática de rendimiento de interfaz.

---

## 2. A 500 conversaciones al día

### Supuestos del escenario

- ~600 contactos, ~500 activos cada día.
- ~25 mensajes por chat y día → **~12.500 mensajes al día**, 1,1 millones en 90 días.
- Mensajes de ~100–200 caracteres. Los de entrada llevan además un `incoming` en JSON.

### Tamaño de los datos (medido)

| | Valor |
|---|---|
| Mensajes sembrados | 1.125.000 (90 días) |
| Tabla `messages` con índices | 384 MB |
| Base completa | 393 MB |
| Costo por mensaje | ~340 B |
| Crecimiento | **~4,3 MB/día, ~1,6 GB/año** |
| `pg_dump -Fc` de esa base | 30 MB, 2,6 s |

El `pg_dump` sale pequeño porque el texto sintético es muy repetitivo y comprime de más. Con texto real, contar 3–4 veces más (cientos de MB al año). En cualquier caso, **el texto de los chats no es el problema de disco ni de backups**: años de conversación caben en el servidor actual.

### Consultas de la pantalla (medido, 1,1 M de mensajes)

| Consulta | Tiempo | Comentario |
|---|---|---|
| Bandeja: 100 conversaciones por `last_message_at` | 0,1 ms | Usa `conversations_last_message_idx` |
| Bandeja: últimos 500 mensajes (`order by id desc limit 500`) | 0,3 ms | Recorre la llave primaria, no crece con el volumen |
| Hilo de un chat de 90 días (1.875 mensajes) | 6,9 ms | Usa `messages_conversation_idx`; trae todo sin paginar |

Las consultas son baratas. Lo que crece con el volumen es **lo que viaja y lo que se pinta**, y hay un error de datos.

### Hallazgos, de mayor a menor

**H1 · El último mensaje de la bandeja puede quedar vacío.** `listConversations` toma los últimos 500 mensajes de toda la base y de ahí saca el último mensaje de cada chat. A 12.500 mensajes al día, 500 mensajes son unos 30–60 minutos de actividad. Los 100 chats de la bandeja abarcan varias horas, así que una parte de ellos no aparece en esos 500 y su vista previa sale en blanco (`lastText: null`). Con poco tráfico no se nota; con 500 chats al día, sí. Arreglo, medido: tomar el último mensaje de cada uno de los 100 chats con un `LATERAL` cuesta **1,1 ms**. La alternativa con `DISTINCT ON` cuesta 374 ms: no usarla.

**H2 · El hilo se descarga completo, otra vez, con cada mensaje de cualquier chat.** `useLive` refresca el hilo abierto con cada aviso de la tabla `messages`, sea del chat que sea. Un chat de restaurante antiguo, con 90 días de conversación, son 1.875 mensajes y ~365 kB de JSON; la pantalla los vuelve a pedir y a pintar entero. A 12.500 mensajes al día el promedio es un aviso cada ~7 s, y en horas pico varios por segundo (el `DEBOUNCE_MS` de 150 ms los junta un poco). Por pestaña abierta, eso son varios cientos de kB por segundo en pico y cientos de burbujas pintadas. Un restaurante activo durante un año llega a ~7.000 mensajes por chat.

**H3 · La bandeja se vuelve a pedir completa en cada aviso.** Cada aviso de `messages`, `conversations` o `couriers` pide de nuevo los 100 chats (~40 kB). Es barato en base de datos, pero se multiplica por cada pestaña abierta.

**H4 · Solo se ven los 100 chats más recientes.** Con ~500 chats al día, los 100 más recientes se renuevan en pocas horas; un chat de la mañana ya no aparece por la tarde y no hay buscador ni «cargar más». Es un límite de producto, no de rendimiento.

### Prueba de carga (medida, Postgres 1 GB, solo la base)

16 lectores simultáneos, cada uno repitiendo el ciclo «bandeja + 500 recientes + hilo de un chat de 90 días», más escritores insertando mensajes (10 % de las transacciones), 40 s:

| | Resultado |
|---|---|
| Ciclos de lectura | ~433 por segundo |
| Escrituras | ~48 por segundo |
| Latencia media | 33 ms (lecturas), 12 ms (escrituras) |
| Fallos | 0 |
| CPU de Postgres | ~12 núcleos de la máquina de prueba (saturados) |
| RAM de Postgres | 580 MB (límite 1 GB) |

Esa máquina tiene muchos más núcleos que el CX23 (2 vCPU compartidos con todos los demás contenedores), así que **las cifras de CPU no se pueden trasladar tal cual**: sirven para ver la forma, no el techo. La lectura prudente: el cuello de botella no es la memoria de Postgres, es la CPU gastada en servir hilos largos una y otra vez (H2).

### Qué aguanta hoy y qué tocaría hacer

- **Aguanta:** el almacenamiento y las consultas a 500 chats al día, con varias personas en el portal. Postgres tiene margen de RAM y de disco por años.
- **Se rompe primero:** H1 (vistas previas vacías) y H2 (hilos largos descargados enteros en cada aviso).
- **Hacer, en issues aparte, por orden:**
  1. Último mensaje por chat con `LATERAL` en `listConversations` (cambio chico, resuelve H1).
  2. Hilo paginado (últimos ~50 mensajes, «cargar anteriores») y refresco incremental: pedir solo `id > último`, y solo cuando el aviso es del chat abierto (hoy el aviso no dice de qué chat es).
  3. Buscador y «cargar más» en la bandeja (H4).
  4. Sin urgencia: archivar o purgar mensajes con más de N meses si se quiere frenar el crecimiento; no hace falta antes de varios años.

---

## 3. Imágenes en los chats

### Qué pasa hoy

- Llega un mensaje de imagen: el webhook lo normaliza a `{ kind: "image", mediaId, caption }` (`services/whatsapp/normalize.ts`) y en `messages.text` queda solo `[Imagen] <pie>` (`bot/intake.ts`, `asText`). **La foto no se guarda en ningún lado.**
- Si el pedido se arma con foto, `order.ts` la descarga de Meta en ese momento (`downloadImage`: primero pide la URL del archivo, luego el archivo, ambos con el token), la pasa a OpenAI en base64 y la descarta. Tope de 5 MB; si falla, el turno sigue con el texto.
- El portal solo muestra `[Imagen]`. Los avisos y fotos que la central quisiera enviar no existen (PLAN.md C-3, fases siguientes).

### Cuánto pesaría guardarlas (estimado, no medido)

Una foto de WhatsApp suele pesar 100–300 kB (WhatsApp la comprime); tomo 150 kB de media. El peso real hay que confirmarlo con fotos reales de los restaurantes.

| Escenario | Fotos/día | Por día | Por mes | Por año |
|---|---|---|---|---|
| Una foto cada 5 chats | 100 | 15 MB | 450 MB | 5,5 GB |
| Una foto por chat | 500 | 75 MB | 2,2 GB | 27 GB |
| Cinco fotos por chat (restaurantes enviando comprobantes) | 2.500 | 375 MB | 11 GB | 137 GB |

Comparado con el texto (~4,3 MB/día), **las fotos pesan de 4 a 90 veces más**. Son ellas, no el texto, las que decidirían el disco y los backups.

### Dónde guardarlas

| Opción | Disco del VPS | Backups | Operación | Veredicto |
|---|---|---|---|---|
| **En PostgreSQL** (`bytea`) | Se come el disco de la base | Cada `pg_dump` las incluye; un JPEG no se comprime, así que el backup crece igual que los datos y se vuelve lento | Simple de programar | **No.** Convierte un backup de cientos de MB en uno de GB y alarga cada restauración |
| **Disco del VPS**, fuera de la base | El CX23 tiene 40 GB; con 75 MB/día se llenaría en pocos meses | Fuera del `pg_dump`, pero entonces hay que respaldarlas aparte | Fácil, pero un VPS caído pierde también las fotos | Aceptable **solo** como paso corto con retención corta (30 días ≈ 2,2 GB a 500 fotos/día) |
| **Almacenamiento de objetos** (Cloudflare R2, o el de Hetzner) | Cero | Separado de la base; tiene su propia durabilidad | Una llave más y un cliente S3 | **Recomendado** como destino final |

### Hasta qué límite cabe en el servidor actual

Regla práctica: no dedicarle más de ~10 GB al disco de fotos, para dejar sitio a Postgres, Docker y las imágenes de los contenedores. Eso son **~65.000 fotos** de 150 kB: 4 meses a 500 fotos/día, 3 semanas a 2.500/día.

### Recomendación

1. Guardar las fotos en un almacenamiento de objetos (R2 o equivalente), con la ruta del archivo en la fila del mensaje, no los bytes. Así `pg_dump` sigue siendo del tamaño del texto.
2. Antes de pagar nada, mirar si Meta conserva el archivo un tiempo y se puede pedir a demanda con el `mediaId` (hoy el id ya queda guardado en `messages.incoming`). Si fuera así, un primer paso sin almacenamiento propio sería pedirla a Meta al abrir el chat. **Hay que confirmar el plazo y las condiciones en la documentación de Meta antes de apoyarse en esto**, y también que cambia con la coexistencia con WhatsApp Business (pendiente del dueño, ver PLAN.md).
3. Reducir el peso al guardar (redimensionar a ~1.600 px y recomprimir) y definir retención (p. ej. 90 días).
4. Esto es la issue de C-3; no entra aquí.

---

## 4. Carga del servidor

### Reparto de memoria (límites de `deploy/compose.yml`)

| Contenedor | Límite |
|---|---|
| postgres | 1 GB |
| bot | 512 MB |
| portal | 512 MB |
| osrm | 512 MB |
| caddy | 128 MB |
| engine | 128 MB |
| worker | 128 MB |
| simulator (solo staging) | 128 MB |
| **Suma** | **3 GB** de los 4 GB del CX23 |

Quedan ~1 GB para el sistema, Docker y el caché de disco. Sin imprevistos, cabe; con todos los contenedores cerca de su límite, el margen es corto.

### Consumo en reposo (referencia local, no es staging)

Del stack de desarrollo en esta máquina, parado y con el simulador activo, sin OSRM:

| Contenedor | CPU | RAM |
|---|---|---|
| portal | 0,0 % | 65 MiB |
| bot | 0,0 % | 60 MiB |
| simulator | 0,0 % | 30 MiB |
| worker | 0,0 % | 25 MiB |
| engine | 0,0 % | 17 MiB |

Estas apps usan una fracción de su límite en reposo. Falta lo que no se pudo medir aquí: **Postgres real, OSRM (el grafo de Cali ocupa memoria fija) y Caddy**. En la prueba de carga de la sección 2, Postgres llegó a 580 MB bajo presión.

### Estimación en pico

- **Postgres** es el que más sube con la actividad (580 MB medidos bajo carga fuerte, límite 1 GB) y el que más CPU pide si el portal sigue descargando hilos enteros (H2).
- **OSRM** tiene un consumo fijo alto (su grafo) pero casi sin CPU salvo cuando el bot cotiza.
- Bot, portal, engine y worker: decenas de MB cada uno en reposo; en pico crecen con las respuestas a OpenAI y las consultas, y siguen muy por debajo de sus límites mientras no haya fugas.
- El `worker` llama a `tick` cada 5 s: es CPU constante pero pequeña, y no depende del número de chats.

### Cómo completar la medición en staging

Con acceso al servidor, en reposo y otra vez durante una hora de actividad (o con el simulador encendido):

```bash
ssh -i ~/.ssh/clapi_ed25519 <tu_usuario>@staging.dispatch.clapi.solutions
nproc; free -m; df -h /; uptime
docker stats --no-stream --format "table {{.Name}}\t{{.CPUPerc}}\t{{.MemUsage}}"
docker exec dispatch-postgres-1 psql -U dispatch -d dispatch -Atc \
  "select pg_size_pretty(pg_database_size('dispatch')); select count(*) from messages;"
```

Pegar el resultado en esta sección. Sin eso, la conclusión sobre «cuánto margen tiene el CX23» es una estimación: los límites suman 3 GB de 4, y la RAM es el recurso a vigilar.

### Cuándo escalar

- **RAM:** si `free -m` en pico deja menos de ~500 MB disponibles, subir de plan (se sube sin reinstalar, según `INFRAESTRUCTURA.md`) antes de mover nada.
- **Disco:** solo si se guardan fotos en el mismo VPS (sección 3). Con el texto solo, no hay presión.
- **CPU:** si Postgres se queda con más de un núcleo sostenido, resolver primero H2 (paginar el hilo) y recién después pagar más máquina.

---

## Resumen

- Escribir en Conversaciones ya no repinta la bandeja ni el hilo, y el envío nunca bloquea la caja (implementado).
- A 500 chats al día, el almacenamiento y las consultas aguantan; lo primero que falla es la vista previa de la bandeja (H1) y el hilo completo descargado en cada aviso (H2). Ambos son arreglos pequeños y van en issues aparte.
- Las imágenes son lo que cambiaría el disco y los backups: no guardarlas en Postgres; usar almacenamiento de objetos.
- La carga real de los contenedores en staging queda por medir (sin acceso SSH desde esta máquina); el comando está arriba.

# Klaviyo Dispatch — Banco de conversaciones reales

## Ejemplos Restaurante ↔ Empresa

**Fuente:** Videos de conversaciones de WhatsApp del 20 de octubre de 2026.  
**Objetivo:** Recopilar interacciones reales para identificar patrones de comunicación, intenciones, extracción de información y comportamientos que debe aprender el bot.

> **Nota:** Se anonimizaron datos personales. Algunos fragmentos se reconstruyeron a partir de capturas parcialmente borrosas; deben tratarse como aproximaciones y verificarse contra los videos antes de usarlos como transcripciones literales o datos de entrenamiento.

---

# 1. Solicitud directa con información del cliente

**Restaurante:**

Hola, tenemos domi:

Nombre: [Nombre del cliente]  
Teléfono: [Teléfono]  
Dirección: [Conjunto residencial, apartamento y dirección]

**Empresa:**

5 mil.

**Restaurante:**

Perfecto, en 8 minutos tenemos el pedido listo, gracias.

**Empresa:**

Vale.

**Restaurante:**

Hola, el pedido ya está listo, gracias.

**Empresa:**

El domiciliario va en camino.

**Intención:** Solicitud directa de domicilio, seguida de información sobre el tiempo de preparación y actualización de disponibilidad.

---

# 2. Solicitud con tiempo de preparación

**Restaurante:**

Hola, tenemos domi:

Nombre: [Nombre del cliente]  
Teléfono: [Teléfono]  
Dirección: [Dirección del cliente]

**Restaurante:**

En 18 minutos tenemos el pedido listo, gracias.

**Empresa:**

Vale.

**Intención:** Solicitud con datos del cliente y tiempo de preparación incluido desde el principio.

---

# 3. Solicitud con dirección incorrecta o dudosa

**Restaurante:**

Hola, tenemos domi:

Nombre: [Nombre del cliente]  
Teléfono: [Teléfono]  
Dirección: Carrera 83B #14A-121, barrio El Ingenio, edificio blanco, apartamento 402.

**Empresa:**

Creo que la dirección está mal. El barrio Ingenio comienza desde la carrera 83C. Estoy casi seguro de que esa dirección no existe.

**Restaurante:**

[Se proporciona una aclaración sobre la ubicación].

**Empresa:**

8 mil.

**Restaurante:**

En 20 minutos sale, gracias.

**Empresa:**

Vale.

**Intención:** Validación y corrección de dirección. El bot debe gestionar aclaraciones sin perder los demás datos de la solicitud.

---

# 4. Varias solicitudes simultáneas

**Restaurante:**

[Envía información del primer cliente y su dirección].

**Empresa:**

5 cada uno.

**Restaurante:**

Sí, ya están los 2.

**Empresa:**

Vale.

**Intención:** Gestión de múltiples domicilios y cotización conjunta o individual.

**Observación:** El bot debe identificar que hay dos entregas y no interpretar la confirmación como si solamente existiera una.

---

# 5. Solicitud con precio y confirmación posterior

**Restaurante:**

[Comparte información del cliente, dirección y conjunto residencial].

**Empresa:**

6 mil.

**Restaurante:**

Sí, ya está.

**Empresa:**

Ok.

**Intención:** El restaurante recibe una tarifa y posteriormente informa que el pedido ya está listo.

---

# 6. Solicitud con precio y confirmación de disponibilidad

**Restaurante:**

[Comparte información del cliente y dirección en el sector Caney].

**Empresa:**

5 mil.

**Restaurante:**

Ya está.

**Empresa:**

Vale.

**Intención:** Cotización seguida de disponibilidad inmediata.

---

# 7. Solicitud mediante información estructurada

**Restaurante:**

Dirección y barrio: [Dirección completa].

Unidad residencial [Nombre de unidad].  
Apartamento 705, torre A.

En 10.

**Empresa:**

¡ENTENDIDO!

**Intención:** El restaurante entrega la dirección y el tiempo en mensajes breves y fragmentados.

**Observación:** El bot debe interpretar expresiones como «en 10» como un tiempo de preparación de 10 minutos cuando el contexto lo permita.

---

# 8. Solicitud mediante mensajes consecutivos

**Restaurante:**

Hola, buenas.

**Empresa:**

Buenas tardes.

**Restaurante:**

[Dirección de entrega].

[Conjunto residencial y apartamento].

[Teléfono del cliente].

[Nombre del cliente].

En 10.

**Empresa:**

¡ENTENDIDO!

**Intención:** Extracción de información enviada en varios mensajes consecutivos.

**Observación:** El bot debe interpretar mensajes consecutivos como partes de una misma solicitud cuando el contexto lo indique, evitando preguntar prematuramente.

---

# 9. Información enviada mediante mensajes reenviados

**Restaurante:**

[Mensaje reenviado con información de ubicación].

Lugar: Centro Comercial Aquarela, local [número].

Horario: De 2:00 p. m. a 7:30 p. m.

Quedo muy pendiente de todo.

**Restaurante:**

Ya está listo, pueden venir porfa.

**Empresa:**

¡ENTENDIDO!

**Intención:** El restaurante puede enviar información mediante mensajes reenviados, incluyendo datos adicionales del lugar de recogida o entrega.

---

# 10. Consulta de cobertura

**Restaurante:**

¿Domis acá?

**Empresa:**

No.

**Intención:** Consulta rápida de disponibilidad o cobertura geográfica.

**Observación:** Si el restaurante envía una ubicación o barrio, el bot debe interpretar esa referencia. Si únicamente proporciona un barrio, puede solicitar una dirección exacta.

---

# 11. Consulta de tarifa para una dirección específica

**Restaurante:**

¿Qué vale el domicilio aquí a la Clínica Farallones?

**Empresa:**

15 mil.

**Intención:** Cotización de un domicilio mediante una ubicación de referencia.

**Observación:** El bot debe distinguir entre una cotización y una solicitud confirmada.

---

# 12. Actualización del estado del pedido

**Restaurante:**

El pedido ya está listo.

**Empresa:**

¡ENTENDIDO!

**Intención:** El restaurante informa que el pedido está preparado.

**Observación:** Este mensaje no debe crear automáticamente otro domicilio. Debe asociarse a una solicitud existente cuando haya una referencia identificable. Si hay varias solicitudes posibles, debe preguntar a cuál se refiere.

---

# 13. Consulta sobre llegada del domiciliario

**Restaurante:**

¿El domicilio ya llegó?

**Empresa:**

[Respuesta sobre el estado del servicio].

**Intención:** Consulta de seguimiento de un servicio existente.

---

# 14. Solicitud con información adicional del pedido

**Restaurante:**

[Información del cliente y dirección].

Efectivo con billete de 100 mil.

2 hamburguesas cheese.

**Empresa:**

9 mil.

**Intención:** El restaurante puede proporcionar observaciones relacionadas con el pago y características del pedido, además de los datos básicos del domicilio.

**Observación:** Estos datos deben conservarse como información adicional, sin confundirlos con los campos obligatorios para solicitar el servicio.

---

# 15. Solicitud con dirección, cliente y tiempo

**Restaurante:**

Nombre: [Nombre del cliente].

Dirección: [Dirección residencial completa].

Teléfono: [Teléfono].

En 10.

**Empresa:**

Vale.

**Intención:** Solicitud directa con datos del cliente y tiempo de preparación.

---

# 16. Cotización seguida de información complementaria

**Restaurante:**

¿Qué vale el domicilio aquí a [ubicación de referencia]?

**Empresa:**

[Tarifa].

**Restaurante:**

Ya está listo, pueden venir por él.

**Empresa:**

[Confirmación de recepción].

**Intención:** La conversación puede comenzar como una consulta de precio y evolucionar posteriormente a una solicitud efectiva.

---

# Observaciones generales extraídas de los videos

1. Los restaurantes no utilizan un formato único para solicitar domicilios.
2. Algunos envían nombre, teléfono y dirección en un solo mensaje.
3. Otros fragmentan los datos en varios mensajes.
4. Algunos comienzan con una cotización y otros solicitan directamente el servicio.
5. Las expresiones «en 10», «en 18» y «ya está» aparecen como formas naturales de comunicar el tiempo de preparación o disponibilidad.
6. Es común que se envíen varios domicilios en una misma conversación.
7. Pueden existir correcciones de direcciones después de haber compartido los datos.
8. Los mensajes reenviados también pueden contener información relevante.
9. Los restaurantes pueden consultar cobertura mediante barrios, establecimientos o ubicaciones.
10. Las respuestas de la empresa suelen ser muy cortas: «Vale», «Ok», «5 mil», «¡ENTENDIDO!».
11. La información adicional puede incluir referencias del lugar, instrucciones de entrega y condiciones de pago.
12. Una cotización y una solicitud confirmada son situaciones diferentes.

## Recomendaciones para usar este banco en el desarrollo

- Tratar cada conversación como un caso de prueba independiente.
- Conservar el orden de los mensajes y quién los envía.
- Separar transcripción observada de interpretación e intención inferida.
- No entrenar con datos personales reales; utilizar datos anonimizados.
- Agregar para cada caso el estado esperado de la solicitud y los cambios esperados en la base de datos.
- Incluir casos ambiguos para comprobar cuándo el bot debe pedir aclaraciones.
- Verificar las transcripciones aproximadas contra los videos originales antes de considerarlas ejemplos literales.

**Conclusión:** El bot debe interpretar conversaciones completas y no mensajes aislados. Debe mantener el contexto, reconocer la intención, extraer información y distinguir solicitudes independientes, cotizaciones y actualizaciones de servicios existentes.

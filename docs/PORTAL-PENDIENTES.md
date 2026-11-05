# Portal: pendientes anotados

Ideas acordadas que todavía no se hacen.

## Conversaciones

Hay que mejorar mucho la fluidez, la interfaz y la comodidad al escribir, y quitar lo que sobra. Se trabaja en un apartado aparte.

## Finanzas

- Métrica opcional: en vez del dinero de los pedidos por método de pago, **cuántos servicios por método** (datáfono, transferencia, efectivo).
- El porcentaje de la agencia (10 %) está fijo en `AGENCY_RATE` (`apps/portal/src/db/queries/settlement.ts`); si cambia por cliente, pasarlo a `settings`.

## Flota

- Mejorar el estilo de «Ver más».

## Imágenes y documentos en los chats

Hoy las imágenes que llegan se guardan solo como el texto `[Imagen]`, los documentos y audios no se procesan, y desde el portal solo se envía texto.

Fases propuestas:

1. Ver en el chat las imágenes y documentos que llegan.
2. Enviar imágenes y PDF desde el portal, con un botón junto al campo de texto.
3. Audios y video, solo si hacen falta.

Dónde se guardan, según lo que se decida de la coexistencia:

- **Con coexistencia:** solo ese día; la copia queda en el WhatsApp Business del cliente.
- **Sin coexistencia:** el tiempo que el negocio necesite, porque la nuestra sería la única copia. Ahí puede convenir almacenamiento externo.

No se puede depender de que Meta los conserve: las fuentes consultadas no coinciden en cuánto tiempo.

Al ver imágenes: abrirlas con su propio zoom, porque el portal bloquea el zoom de la página (`viewport` en `apps/portal/src/app/layout.tsx`).

## Coexistencia con WhatsApp Business

El mismo número funcionando a la vez en la app y en la API, con los mensajes reflejados en ambos lados.

Por confirmar:

- Que esté disponible en Colombia.
- Los requisitos de Meta: registrarnos como proveedor (recomendado, porque CLAPI conectará más agencias) o usar uno existente.
- Que el número actual pueda conectarse así.
- Con un número de prueba, que las imágenes lleguen a la app.

Si se hace, el bot debe procesar el aviso `smb_message_echoes`: lo que se escriba desde la app se ve en el portal y pausa ese chat, para que el bot no conteste encima.

## Datos y caídas del sistema

Hoy no hay backups (`docs/INFRAESTRUCTURA.md`): si se daña el servidor, se pierden los pedidos y los chats. Resolver antes de salir a producción.

- Backup diario de la base, guardado fuera del servidor.
- Probar una restauración de verdad.
- Alerta si el sistema se cae.
- Plan de contingencia escrito: qué hace la central si cae en hora pico.
- Confirmar por cuánto tiempo reintenta Meta los mensajes y revisar que, al volver, el bot no responda mensajes viejos como si fueran nuevos.

## Fotos de restaurantes y domiciliarios

Ya se suben y se ven en Restaurantes y Flota. Falta mostrarlas en la lista de chats, el encabezado del chat y las tarjetas de Viajes.

## Restaurantes sin número

Un restaurante ya puede registrarse sin WhatsApp, pero el bot solo reconoce por número. Falta decidir si debe reconocerlos también por el nombre.

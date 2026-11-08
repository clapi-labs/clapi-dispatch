# Simulador de despacho (demo)

**Referencia:** esta es la versión de la demostración. Aquí el simulador asigna en memoria y envía sus propios mensajes, con la ficha anterior. Sirve de referencia para el mapa y los controles; el simulador de staging no debe repetir esa lógica.

Muestra en un mapa cómo el engine (`apps/engine`) asignaría los pedidos que llegan **por WhatsApp al bot real**, usando 8 motos de ejemplo regadas por Cali. Es solo para demostraciones:

- **Solo lee** la base (`trips`, `messages`, `conversations`, `restaurants`). No escribe nada ni asigna motorizados reales: en la base los pedidos quedan pendientes.
- **Envía WhatsApp de la demo** (si `.env.simulador` trae las variables de WhatsApp): cuando asigna un pedido que llegó por WhatsApp, la ficha de la moto de ejemplo («Nuevo viaje B1007 para Fabio») le llega a un único número, `DEMO_MOTORIZADO`, que hace de toda la flota; al restaurante le llega «Va Fabio». Cuando ese número toca «Terminé el servicio», el simulador cierra el pedido y avisa a los dos.
- Las motos, sus rutas y entregas viven en memoria; «Reiniciar» las devuelve al inicio.
- Llama al engine real por `POST /evaluar` (lo levanta solo, como proceso hijo). Necesita `python3`.

## Correrlo contra staging

1. Abrir el túnel a la base de staging (deja la terminal abierta):

   ```bash
   tools/simulador-demo/tunel-staging.sh tu_usuario
   ```

2. En otra terminal, con la contraseña de Postgres de staging (`POSTGRES_PASSWORD` en `/opt/dispatch/.env` del servidor):

   ```bash
   echo "DATABASE_URL=postgres://dispatch:LA_CLAVE@localhost:5434/dispatch" > .env.simulador
   npm run sim:demo
   ```

3. Abrir http://localhost:4000 y escribirle al número de WhatsApp de staging.

En local (con `docker compose up`) basta `DATABASE_URL=postgres://dispatch:dispatch@localhost:5432/dispatch npm run sim:demo` y `npm run bot:chat` para escribirle al bot desde la terminal. Sin `DATABASE_URL` funciona solo con pedidos creados desde el mapa.

## WhatsApp de la demo

En `.env.simulador`, además de `DATABASE_URL`:

```
WHATSAPP_PHONE_NUMBER_ID=...   # los mismos del bot de staging
WHATSAPP_ACCESS_TOKEN=...
DEMO_MOTORIZADO=573001234567   # quien recibe las fichas de todas las motos
```

Registrar al motorizado de la demo en staging (queda en pausa: el bot lo reconoce, pero la cola real no le asigna nada):

```bash
tools/simulador-demo/motorizado-demo.sh tu_usuario 573001234567 "Nombre"
```

Antes de la demo, el restaurante y el motorizado le escriben «hola» al bot: WhatsApp solo deja enviar mensajes libres a quien escribió en las últimas 24 h. Para ver una ficha sin crear un pedido: `tools/simulador-demo/ficha-ejemplo.mjs`.

## Qué se ve

- **Izquierda:** la conversación de WhatsApp (lo que escribe el restaurante y lo que responde el bot) y la bitácora de lo que pasa.
- **Mapa:** motos (🛵, con cuántos pedidos llevan), restaurantes 🍔, clientes 🏠 y la ruta de cada moto. Al seleccionar un pedido que espera se ven el radio y las 3 mejores rutas (verde la ganadora).
- **Derecha:** el ranking del pedido seleccionado, con el puntaje partido en tiempo, ruta y equidad, el motivo de cada moto excluida y la explicación de por qué ganó.

Solo se toman los pedidos creados desde 2 minutos antes de arrancar (o de «Reiniciar»). Si el pedido no trae «listo en», se supone 10 minutos. Si al bot le faltó ubicar el restaurante o el cliente, se puede marcar en el mapa.

## Cómo intervenir

| Control | Qué muestra |
|---|---|
| Horario: pico / valle | En pico gana la rapidez; en valle, la equidad (la moto que menos ha hecho o más lleva esperando) |
| Varios pedidos por moto | Agrupar pedidos de camino, o solo motos libres |
| Radio | Motos fuera del radio quedan excluidas |
| Velocidad 1×–20× | Acelera el reloj para no esperar los minutos reales de cocina y recorrido |
| Clic en una moto → Cliente no contesta | La moto espera 10 min al cliente y no recibe pedidos; luego devuelve el pedido |
| Clic en una moto → Desconectar | Sus pedidos sin recoger vuelven a la cola y se reasignan solos |
| Pedido → Terminé el servicio (sin WhatsApp) | Cierra el pedido si el motorizado no puede tocar el botón |
| Pedido → Asignar ya / Asignar a mano / Cancelar | El despachador pasa por encima del algoritmo |
| + Pedido en el mapa / + Moto | Armar casos a mano (respaldo si WhatsApp falla en la demo) |

Un pedido con la comida aún en preparación **no se asigna enseguida**: el engine espera a que la mejor moto tenga que salir para llegar justo cuando la comida esté lista (asignación diferida). El panel muestra cuánto falta y quién ganaría hoy.

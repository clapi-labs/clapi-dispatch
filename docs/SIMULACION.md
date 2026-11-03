# Simulación para el cliente

Estado: **por idear.** El cliente quiere ver cómo funciona todo junto (el bot, el despacho y el portal) antes de usarlo de verdad.

## Lo que tiene que mostrar

- Restaurantes pidiendo por WhatsApp, el bot cotizando y confirmando.
- El algoritmo escogiendo motorizado (por qué ese y no otro).
- Motorizados moviéndose en el mapa, recogiendo y terminando.
- El tablero del portal actualizándose solo.
- Una novedad (accidente) y cómo interviene William.

## Sin WhatsApp abierto

No debería depender de teléfonos reales ni de Meta. Lo que ya existe y sirve de base:

- **WhatsApp simulado** (`WHATSAPP_SIMULADO=true`): el bot no le habla a Meta; cada envío se imprime. Es lo que usa `npm run bot:chat`.
- **Modo demo del portal** (`apps/portal/src/lib/demo.ts`).
- **Seed de demostración** (`npm run db:seed:demo`).
- **El engine es una función pura** (`POST /evaluar`): se le puede dar una flota y pedidos inventados.

## Opciones (por decidir)

1. **Guion reproducible:** un script que lanza pedidos de restaurantes ficticios cada pocos segundos (textos tomados de [CONVERSACIONES-REALES.md](CONVERSACIONES-REALES.md)), mueve a los motorizados por el mapa y toca sus botones. El portal muestra todo en vivo. Lo más fiel: corre el bot y el despacho de verdad.
2. **Página de simulación:** una vista con los chats de WhatsApp de mentira a un lado (restaurantes y motorizados) y el mapa y el tablero al otro, alimentada por el mismo guion. Más vistosa para una reunión.
3. **Video grabado** de la opción 1, para mandar sin estar presentes.

Recomendación inicial: la 1 primero (sirve también como prueba de carga) y la 2 encima si el cliente la necesita.

Depende de: el algoritmo conectado (rama del engine) y, para que las distancias sean reales, Google o el geocodificador propio.

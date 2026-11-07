// Manda a un número la ficha de ejemplo que recibe un motorizado al asignarle
// un pedido (mismo texto y botón que apps/bot/src/bot/notify.ts). No toca la
// base: es solo para ver cómo se ve. Se corre dentro del contenedor del bot:
//   ssh … 'docker exec -i dispatch-bot-1 node - 573001234567' < tools/simulador-demo/ficha-ejemplo.mjs

const to = process.argv[2];
if (!to) throw new Error("Falta el número: node - 57300…");

const text = [
  "🛵 *Nuevo viaje B1007*",
  "",
  "📍 Recoge: prueba · Carrera 22 #3 Sur - 30, Jamundí",
  "🏁 Entrega: Carrera 122 # 14-50, Pance",
  "📞 Cliente: Andrés Ruiz · 310 456 7890",
  "💵 Valor del pedido: $ 38.000",
  "📝 Lleva cambio de 50 mil",
  "",
  "🗺️ https://waze.com/ul?ll=3.3421,-76.5301&navigate=yes",
  "",
  "Toca el botón cuando termines. Si te toca volver al restaurante (por el cambio, por ejemplo), tócalo al volver 👇",
].join("\n");

const { WHATSAPP_API_VERSION = "v21.0", WHATSAPP_PHONE_NUMBER_ID, WHATSAPP_ACCESS_TOKEN } = process.env;
const r = await fetch(`https://graph.facebook.com/${WHATSAPP_API_VERSION}/${WHATSAPP_PHONE_NUMBER_ID}/messages`, {
  method: "POST",
  headers: { "Content-Type": "application/json", Authorization: `Bearer ${WHATSAPP_ACCESS_TOKEN}` },
  body: JSON.stringify({
    messaging_product: "whatsapp",
    to,
    type: "interactive",
    // Un id que el bot no reconoce: si se toca, no cierra ningún viaje real.
    interactive: { type: "button", body: { text }, action: { buttons: [{ type: "reply", reply: { id: "ejemplo", title: "Terminé el servicio" } }] } },
  }),
});
console.log(r.status, JSON.stringify(await r.json()));

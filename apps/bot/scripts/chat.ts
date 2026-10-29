/**
 * Chat de prueba por terminal: escribes como si fueras un restaurante (o un
 * motorizado) y el bot responde aquí mismo, sin pasar por WhatsApp. Usa la
 * base y OpenAI de verdad; solo los envíos a Meta quedan simulados.
 *
 *   npm run bot:chat                      # como el restaurante de prueba
 *   npm run bot:chat -- 573001234567      # como ese número
 *
 * Comandos dentro del chat:
 *   /de <número>     cambia quién escribe (restaurante o motorizado)
 *   /boton <id>      toca un botón (el id sale entre paréntesis en la respuesta)
 *   /ubicacion <lat>,<lng> [nombre]   envía un pin de ubicación
 *   """              abre y cierra un mensaje de varias líneas (cada línea
 *                    suelta es un mensaje aparte, como en WhatsApp)
 *   /salir
 */
import { createInterface } from "node:readline/promises";

process.env.WHATSAPP_SIMULADO = "true";

const DEFAULT_PHONE = "573000000001";

async function main() {
  const { handleIncoming } = await import("../src/bot/intake");
  type Incoming = Parameters<typeof handleIncoming>[0];

  let phone = process.argv[2] ?? DEFAULT_PHONE;
  let counter = 0;

  const send = async (content: Pick<Incoming, "kind"> & Record<string, unknown>) => {
    const message = {
      waMessageId: `sim-${Date.now()}-${counter++}`,
      phone,
      profileName: null,
      timestamp: new Date(),
      ...content,
    } as Incoming;
    try {
      await handleIncoming(message);
    } catch (error) {
      console.error("⚠️ ", error instanceof Error ? error.message : error);
    }
  };

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  // Se leen las líneas en orden con el iterador: así funciona igual escribiendo
  // a mano que pasando una conversación por tubería (`printf ... | npm run bot:chat`).
  let block: string[] | null = null; // mensaje de varias líneas en curso
  const prompt = () => {
    rl.setPrompt(block ? "… " : `${phone} > `);
    rl.prompt();
  };

  console.log(`Chat simulado. Escribes como ${phone}. /de <número>, /boton <id>, /ubicacion <lat>,<lng>, """ para varias líneas, /salir.\n`);
  prompt();

  for await (const raw of rl) {
    const line = raw.trim();

    if (block) {
      if (line === '"""') {
        if (block.length) await send({ kind: "text", text: block.join("\n") });
        block = null;
      } else {
        block.push(raw);
      }
    } else if (line === "/salir") {
      break;
    } else if (line === '"""') {
      block = [];
    } else if (line) {
      const [command, ...rest] = line.split(" ");
      const arg = rest.join(" ").trim();

      if (command === "/de" && arg) {
        phone = arg.replace(/\D/g, "");
        console.log(`Ahora escribes como ${phone}.\n`);
      } else if (command === "/ubicacion" && arg) {
        const [coords, ...label] = arg.split(" ");
        const [lat, lng] = coords.split(",").map(Number);
        if (Number.isFinite(lat) && Number.isFinite(lng)) {
          await send({ kind: "location", lat, lng, label: label.join(" ") || null });
        } else {
          console.log("Uso: /ubicacion 3.3772,-76.5225 [nombre del lugar]\n");
        }
      } else if (command === "/boton" && arg) {
        await send({ kind: "button", buttonId: arg, title: arg });
      } else {
        await send({ kind: "text", text: line });
      }
    }
    prompt();
  }

  rl.close();
  process.exit(0);
}

main();

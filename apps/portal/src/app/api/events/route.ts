import { subscribeChanges } from "@dispatch/shared/db";

export const dynamic = "force-dynamic";

/**
 * Avisos en vivo para el tablero (Server-Sent Events): cada mensaje es el
 * nombre de la tabla que cambió ("trips", "messages"…), y el navegador vuelve
 * a pedir solo lo que le toca (lib/live.ts). Si nada cambia, no viaja nada más
 * que un latido cada 25 s, que mantiene viva la conexión a través de Caddy.
 */
export async function GET(request: Request) {
  const encoder = new TextEncoder();
  let cleanup = () => {};

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const send = (text: string) => {
        try {
          controller.enqueue(encoder.encode(text));
        } catch {
          cleanup();
        }
      };

      send("retry: 3000\n\n");
      const unsubscribe = subscribeChanges((event) => {
        if (event === "ready" || event === "down") send(`event: ${event}\ndata: 1\n\n`);
        else send(`data: ${event}\n\n`);
      });
      const ping = setInterval(() => send(": ping\n\n"), 25_000);

      cleanup = () => {
        unsubscribe();
        clearInterval(ping);
      };
      request.signal.addEventListener("abort", () => {
        cleanup();
        try {
          controller.close();
        } catch {}
      });
    },
    cancel() {
      cleanup();
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}

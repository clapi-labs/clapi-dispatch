/**
 * El envío de mensajes de la central, sin interfaz: una cola que manda de a uno
 * y en orden, para que la caja de texto pueda vaciarse al instante y el envío
 * siga en segundo plano. Un envío que falla (la respuesta no es ok, o la red
 * se cae) avisa con el texto que no salió, para devolverlo a la caja; no frena
 * los que siguen en la cola.
 */
export type SendResult = { ok: true } | { ok: false; reason?: string };

export type SendHandlers = {
  /** El texto no salió: se puede devolver a la caja. */
  onFail: (text: string, reason: string | undefined) => void;
  /** Terminó, haya salido o no. */
  onDone: () => void;
};

export function createSendQueue(post: (text: string) => Promise<SendResult>) {
  let tail: Promise<void> = Promise.resolve();
  return function enqueue(text: string, handlers: SendHandlers) {
    tail = tail.then(async () => {
      try {
        const result = await post(text);
        if (!result.ok) handlers.onFail(text, result.reason);
      } catch {
        handlers.onFail(text, undefined);
      }
      handlers.onDone();
    });
    return tail;
  };
}

/**
 * Cola simple: como mucho `max` tareas a la vez, las demás esperan su turno en
 * orden. Procesar una foto grande gasta memoria; si llegan varias juntas, se
 * hacen de a una o dos y no todas a la vez.
 */
export class Limiter {
  private active = 0;
  private waiting: (() => void)[] = [];

  constructor(private readonly max: number) {
    if (!Number.isInteger(max) || max < 1) throw new Error("Limiter: max debe ser un entero de al menos 1");
  }

  get running() {
    return this.active;
  }

  get queued() {
    return this.waiting.length;
  }

  async run<T>(task: () => Promise<T>): Promise<T> {
    if (this.active >= this.max) await new Promise<void>((resolve) => this.waiting.push(resolve));
    else this.active += 1;
    try {
      return await task();
    } finally {
      const next = this.waiting.shift();
      if (next)
        next(); // el turno pasa directo al que sigue, sin soltar el cupo
      else this.active -= 1;
    }
  }
}

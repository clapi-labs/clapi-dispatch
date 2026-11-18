/**
 * El timbre del portal (un chat pide ayuda, un viaje se atascó): dos notas cortas (La5 → Mi6), sintetizadas
 * con Web Audio. Sin archivo de audio que cargar ni que pueda fallar.
 *
 * Los navegadores no dejan sonar nada hasta que la persona toca la página una
 * vez; `unlockAudio()` se engancha al primer toque (ver TripsProvider).
 */
let ctx: AudioContext | null = null;

export function unlockAudio() {
  try {
    if (!ctx) ctx = new AudioContext();
    if (ctx.state === "suspended") void ctx.resume();
  } catch {
    // Sin Web Audio: la alerta visual sigue funcionando.
  }
}

export function isAudioReady() {
  return ctx !== null && ctx.state === "running";
}

export function playChime() {
  if (!ctx || ctx.state !== "running") return;
  const audio = ctx;
  const start = audio.currentTime;

  [880, 1318.5].forEach((freq, i) => {
    const osc = audio.createOscillator();
    const gain = audio.createGain();
    const t = start + i * 0.13;
    osc.type = "sine";
    osc.frequency.value = freq;
    gain.gain.setValueAtTime(0, t);
    gain.gain.linearRampToValueAtTime(0.16, t + 0.015);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.45);
    osc.connect(gain);
    gain.connect(audio.destination);
    osc.start(t);
    osc.stop(t + 0.5);
  });
}

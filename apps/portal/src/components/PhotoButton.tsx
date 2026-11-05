"use client";

import { Camera, Trash2 } from "lucide-react";
import { useState, type ChangeEvent } from "react";

import { Modal } from "@/components/Modal";
import { initials } from "@/lib/format";

const SIZE = 192;

/** Recorta al centro y reduce: la foto se guarda en la base, así que pesa poco. */
async function toSmallJpeg(file: File): Promise<string> {
  const bitmap = await createImageBitmap(file);
  const side = Math.min(bitmap.width, bitmap.height);
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = SIZE;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("Sin canvas");
  context.drawImage(bitmap, (bitmap.width - side) / 2, (bitmap.height - side) / 2, side, side, 0, 0, SIZE, SIZE);
  bitmap.close();
  return canvas.toDataURL("image/jpeg", 0.82);
}

/** La foto de un restaurante o motorizado. Sin foto, sus iniciales. Tocarla deja cambiarla o quitarla. */
export function PhotoButton({
  name,
  photo,
  className,
  onChange,
}: {
  name: string;
  photo: string | null;
  /** Tamaño y color de las iniciales. */
  className: string;
  onChange: (photo: string | null) => Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function apply(next: () => Promise<string | null>) {
    setBusy(true);
    setError(null);
    try {
      await onChange(await next());
      setOpen(false);
    } catch {
      setError("No se pudo guardar la foto. Prueba con otra imagen.");
    }
    setBusy(false);
  }

  function pick(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (file) apply(() => toSmallJpeg(file));
  }

  const face = (classes: string) =>
    photo ? (
      // eslint-disable-next-line @next/next/no-img-element -- la foto es un data URL guardado en la base.
      <img src={photo} alt="" className={`rounded-full object-cover ${classes}`} />
    ) : (
      <span className={`flex items-center justify-center rounded-full font-bold ${classes} ${className}`}>{initials(name) || "#"}</span>
    );

  return (
    <>
      <button type="button" onClick={() => setOpen(true)} aria-label={`Foto de ${name}`} title="Cambiar la foto" className="ease-ui block rounded-full active:scale-95">
        {face(`${className} block`)}
      </button>
      {open && (
        <Modal label={`Foto de ${name}`} onClose={() => setOpen(false)}>
          <div className="flex flex-col items-center gap-2">
            {face("h-28 w-28 text-2xl")}
            <p className="text-center text-base font-semibold text-ink">{name}</p>
          </div>
          {error && <p className="rounded-lg bg-danger-soft px-3 py-2 text-xs text-danger">{error}</p>}
          <label className={`ease-ui flex h-10 cursor-pointer items-center justify-center gap-2 rounded-xl bg-clapi text-sm font-semibold text-white ${busy ? "pointer-events-none opacity-50" : ""}`}>
            <Camera size={16} /> {busy ? "Guardando…" : photo ? "Cambiar foto" : "Subir foto"}
            <input type="file" accept="image/*" onChange={pick} className="hidden" />
          </label>
          {photo && (
            <button type="button" disabled={busy} onClick={() => apply(async () => null)} className="ease-ui flex h-10 items-center justify-center gap-2 rounded-xl bg-danger-soft text-sm font-semibold text-danger disabled:opacity-50">
              <Trash2 size={15} /> Quitar foto
            </button>
          )}
          <button type="button" onClick={() => setOpen(false)} className="ease-ui h-10 rounded-xl bg-sunken text-sm font-semibold text-ink-2">
            Cerrar
          </button>
        </Modal>
      )}
    </>
  );
}

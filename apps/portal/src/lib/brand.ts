/**
 * Marca mixta: el cascarón es CLAPI (morado + amarillo) y el cliente pone su
 * color y su nombre encima — el logo y los botones principales.
 *
 * Para otro cliente no se toca código: se cambian las tres variables
 * NEXT_PUBLIC_CLIENT_* en Vercel y se redespliega. `NEXT_PUBLIC_` porque las
 * lee el navegador.
 */
export const BRAND = {
  platform: {
    name: "CLAPI",
    product: "Dispatch",
  },
  client: {
    name: process.env.NEXT_PUBLIC_CLIENT_NAME || "Express Cali",
    initials: process.env.NEXT_PUBLIC_CLIENT_INITIALS || "EC",
    /** Rojo de Express Cali. Cualquier color que se lea con texto blanco. */
    primary: process.env.NEXT_PUBLIC_CLIENT_COLOR || "#E11D48",
  },
};

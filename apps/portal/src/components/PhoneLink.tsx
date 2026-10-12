import { Phone } from "lucide-react";
import Link from "next/link";

import { chatHref } from "@/lib/chat";
import { formatPhone } from "@/lib/format";

/**
 * Un teléfono que se puede tocar. Lleva al chat de ese número en la pestaña
 * Conversaciones del portal, no al WhatsApp de la persona, y lo hace igual en
 * computador que en celular. Para llamar está el botón del encabezado del chat.
 */
export function PhoneLink({
  phone,
  name,
  pill,
  className = "",
}: {
  phone: string;
  name?: string;
  /** Cápsula lavanda que se llena de violeta al pasar el cursor, en vez de un enlace de texto. */
  pill?: boolean;
  className?: string;
}) {
  const look = pill
    ? "whitespace-nowrap rounded-full bg-clapi-soft px-2.5 py-1 text-[11px] font-semibold text-clapi-ink active:bg-clapi active:text-white can-hover:hover:bg-clapi can-hover:hover:text-white"
    : "underline-offset-2 decoration-clapi/40 can-hover:hover:text-clapi-ink can-hover:hover:underline";

  return (
    <Link
      href={chatHref(phone)}
      title={name ? `Abrir la conversación con ${name}` : "Abrir la conversación"}
      // El `after` agranda la zona que responde al dedo sin mover nada de sitio.
      className={`ease-ui relative inline-flex cursor-pointer items-center gap-1 after:absolute after:-inset-x-1 after:-inset-y-2 after:content-[''] ${look} ${className}`}
    >
      <Phone size={12} className="shrink-0" />
      {formatPhone(phone)}
    </Link>
  );
}

import { MessagesSquare, Phone } from "lucide-react";
import Link from "next/link";

import { chatHref } from "@/lib/chat";
import { formatPhone, phoneDigits } from "@/lib/format";

/**
 * Un teléfono que se puede tocar. Lleva al chat de ese número en la pestaña
 * Conversaciones del portal, no al WhatsApp de la persona, y lo hace igual en
 * computador que en celular. Con `call` marca el número en vez de abrir el
 * chat. Con `iconOnly` es un botón sin texto y el número no se muestra:
 * redondo, o con `wide` una barra que se reparte el ancho de su fila.
 */
export function PhoneLink({
  phone,
  name,
  pill,
  call,
  iconOnly,
  wide,
  className = "",
}: {
  phone: string;
  name?: string;
  /** Cápsula lavanda que se llena de violeta al pasar el cursor, en vez de un enlace de texto. */
  pill?: boolean;
  /** Llama en vez de abrir la conversación: para quien no le escribe al bot, como el cliente final. */
  call?: boolean;
  /** Solo el ícono, en un botón redondo cómodo para el dedo. Qué hace y a qué número quedan
   *  en la ayuda al pasar el cursor y para los lectores de pantalla. */
  iconOnly?: boolean;
  /** Con `iconOnly`: en vez de redondo, tan alto y de esquinas como los botones de su fila, y ocupa el ancho libre. */
  wide?: boolean;
  className?: string;
}) {
  const tint = "bg-clapi-soft text-clapi-ink active:bg-clapi active:text-white can-hover:hover:bg-clapi can-hover:hover:text-white";
  // En texto, el `after` agranda la zona que responde al dedo sin mover nada de sitio.
  // El botón de ícono ya la tiene: 40 px en celular, 32 el redondo donde hay cursor.
  const look = iconOnly
    ? `justify-center ${wide ? "h-10 flex-1 rounded-xl" : "h-10 w-10 shrink-0 rounded-full lg:h-8 lg:w-8"} ${tint}`
    : `gap-1 after:absolute after:-inset-x-1 after:-inset-y-2 after:content-[''] ${
        pill
          ? `whitespace-nowrap rounded-full px-2.5 py-1 text-[11px] font-semibold ${tint}`
          : "underline-offset-2 decoration-clapi/40 can-hover:hover:text-clapi-ink can-hover:hover:underline"
      }`;
  const classes = `ease-ui relative inline-flex cursor-pointer items-center ${look} ${className}`;
  // Un número lleva el ícono de teléfono vaya a donde vaya; un botón, el de lo que hace.
  const Icon = call || !iconOnly ? Phone : MessagesSquare;
  const content = iconOnly ? (
    <Icon className={wide ? "size-[18px]" : "size-[18px] lg:size-[15px]"} />
  ) : (
    <>
      <Icon size={12} className="shrink-0" />
      {formatPhone(phone)}
    </>
  );
  const action = call ? (name ? `Llamar a ${name}` : "Llamar") : name ? `Abrir la conversación con ${name}` : "Abrir la conversación";
  const title = iconOnly ? `${action} · ${formatPhone(phone)}` : action;
  const label = iconOnly ? title : undefined;

  if (call) {
    return (
      <a href={`tel:+${phoneDigits(phone)}`} title={title} aria-label={label} className={classes}>
        {content}
      </a>
    );
  }

  return (
    <Link href={chatHref(phone)} title={title} aria-label={label} className={classes}>
      {content}
    </Link>
  );
}

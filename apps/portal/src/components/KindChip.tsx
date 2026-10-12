import { Bike, Store } from "lucide-react";

import type { ConversationKind } from "@/lib/types";

/** Un restaurante y un motorizado nunca se ven igual: cada uno con su ícono,
 *  su texto y su color, en la lista y en el encabezado del chat. */
export const KINDS = {
  restaurant: {
    label: "Restaurante",
    Icon: Store,
    tint: "bg-clapi/15 text-clapi-ink",
    selected: "bg-clapi-soft/70",
  },
  courier: {
    label: "Motorizado",
    Icon: Bike,
    tint: "bg-courier/15 text-courier-ink",
    selected: "bg-courier-soft/70",
  },
};

export function KindChip({ kind }: { kind: ConversationKind }) {
  const { label, Icon, tint } = KINDS[kind];
  return (
    <span className={`flex shrink-0 items-center gap-1 rounded-md px-1.5 py-0.5 text-[11px] font-semibold ${tint}`}>
      <Icon size={11} /> {label}
    </span>
  );
}

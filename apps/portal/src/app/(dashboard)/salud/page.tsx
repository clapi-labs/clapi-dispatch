import { redirect } from "next/navigation";

import { isAdmin, isUserAdmin } from "@/lib/admin";

import { PortalUsersCard } from "./PortalUsersCard";
import { SystemHealthView } from "./SystemHealthView";

export const dynamic = "force-dynamic";

/** Solo administradores (`lib/admin.ts`); los demás vuelven al tablero. */
export default async function SaludPage() {
  if (!(await isAdmin())) redirect("/viajes");
  return (
    <>
      <SystemHealthView />
      {(await isUserAdmin()) ? (
        <div className="mx-auto max-w-3xl px-4 pb-8 lg:px-8">
          <PortalUsersCard />
        </div>
      ) : null}
    </>
  );
}

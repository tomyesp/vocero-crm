import { withAuth } from "@/lib/api";
import { inventoryDisabledResponse, inventoryEnabled } from "@/server/inventory/flag";
import { getCatalog } from "@/server/inventory/queries";

export const dynamic = "force-dynamic";

/** 017 — Catálogo completo (categorías + modelos + unidades + tarifa vigente). */
export const GET = withAuth(async (session) => {
  if (!inventoryEnabled()) return inventoryDisabledResponse();
  const catalog = await getCatalog(session.organizationId);
  return Response.json(catalog);
});

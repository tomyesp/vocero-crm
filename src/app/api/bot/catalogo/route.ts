import { apiError } from "@/lib/api";
import { requireBotKey, resolveInstanceOrg } from "@/server/bot/auth";
import { inventoryDisabledResponse, inventoryEnabled } from "@/server/inventory/flag";
import { getCatalog } from "@/server/inventory/queries";

export const dynamic = "force-dynamic";

/**
 * 017 — El catálogo para el cerebro externo: la "knowledge base viva" de
 * máquinas. El agente NO puede nombrar una máquina que no salga de acá.
 *
 * Solo modelos activos, con specs, rango de precios vigente y cuántas
 * unidades existen (no cuántas están libres: eso es de /disponibilidad).
 */
export async function GET(req: Request) {
  // La bandera ANTES que la llave: sin inventario, el endpoint no existe.
  if (!inventoryEnabled()) return inventoryDisabledResponse();

  const denied = requireBotKey(req);
  if (denied) return denied;

  const organizationId = await resolveInstanceOrg();
  if (!organizationId) {
    return apiError(409, "no_org", "La instancia aún no tiene organización");
  }

  const q = new URL(req.url).searchParams.get("q")?.trim().toLowerCase() ?? "";
  const catalog = await getCatalog(organizationId);
  const categoryById = new Map(catalog.categories.map((c) => [c.id, c]));

  const modelos = catalog.models
    .filter((m) => m.active)
    .filter((m) => {
      if (!q) return true;
      const cat = categoryById.get(m.categoryId);
      return [m.name, m.brand ?? "", cat?.name ?? "", m.description ?? ""]
        .join(" ")
        .toLowerCase()
        .includes(q);
    })
    .map((m) => ({
      modeloId: m.id,
      nombre: m.name,
      marca: m.brand,
      categoria: categoryById.get(m.categoryId)?.name ?? null,
      descripcion: m.description,
      specs: m.specs,
      requiereOperario: m.requiresOperator,
      unidades: m.units.filter((u) => u.status !== "baja").length,
      tarifa: m.currentRate
        ? {
            diariaCents: m.currentRate.dailyCents,
            semanalCents: m.currentRate.weeklyCents,
            mensualCents: m.currentRate.monthlyCents,
            trasladoBaseCents: m.currentRate.transferBaseCents,
            trasladoPorKmCents: m.currentRate.transferPerKmCents,
            operarioDiaCents: m.currentRate.operatorDailyCents,
          }
        : null,
    }));

  return Response.json({
    categorias: catalog.categories.map((c) => ({ id: c.id, nombre: c.name, slug: c.slug })),
    modelos,
  });
}

import { apiError } from "@/lib/api";
import { requireBotKey, resolveInstanceOrg } from "@/server/bot/auth";
import { inventoryDisabledResponse, inventoryEnabled } from "@/server/inventory/flag";
import { getCatalog } from "@/server/inventory/queries";

export const dynamic = "force-dynamic";

/**
 * 017 — El catálogo para el cerebro externo: la "knowledge base viva" de
 * máquinas. El agente NO puede nombrar una máquina que no salga de acá.
 *
 * Solo modelos activos, con specs, tarifa horaria vigente y cuántas unidades
 * existen (no cuántas están libres: eso es de /disponibilidad).
 *
 * La tarifa que viaja acá es de REFERENCIA —"la hora sale tanto"— y alcanza
 * para contestar "¿cuánto sale?" sin inventar nada. El precio de una obra
 * concreta sigue saliendo de /cotizar.
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
            horaCents: m.currentRate.hourlyCents,
            minimoHoras: m.currentRate.minHours,
            trasladoBaseCents: m.currentRate.transferBaseCents,
            trasladoPorKmCents: m.currentRate.transferPerKmCents,
          }
        : null,
    }));

  return Response.json({
    categorias: catalog.categories.map((c) => ({ id: c.id, nombre: c.name, slug: c.slug })),
    modelos,
    // Condiciones del negocio que valen para TODO el catálogo. Van en la
    // respuesta y no en el prompt para que el agente no las recite de memoria:
    // si algún día cambian, cambian acá y el agente se entera solo.
    condiciones: {
      unidad: "hora",
      incluyeOperario: true,
      incluyeCombustible: true,
      incluyeIva: false,
      incluyeTraslado: false,
    },
  });
}

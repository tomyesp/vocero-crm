import { asc, desc, eq, inArray } from "drizzle-orm";
import { getDb, schema } from "@/lib/db";
import { scoped } from "@/lib/db/tenant";

/**
 * 017 — DTOs de lectura para la UI del inventario. Serializan fechas a ISO y
 * juntan lo que las pantallas muestran junto (modelo + unidades + tarifa
 * vigente; reserva + máquina + contacto) para que el cliente solo pinte.
 */

export type CatalogModel = {
  id: string;
  categoryId: string;
  name: string;
  brand: string | null;
  specs: Record<string, unknown>;
  description: string | null;
  photos: string[];
  requiresOperator: boolean;
  active: boolean;
  units: {
    id: string;
    internalCode: string;
    year: number | null;
    usageHours: number;
    status: "operativa" | "mantenimiento" | "baja";
    notes: string | null;
  }[];
  currentRate: {
    id: string;
    dailyCents: number;
    weeklyCents: number | null;
    monthlyCents: number | null;
    transferBaseCents: number;
    transferPerKmCents: number;
    operatorDailyCents: number;
    validFrom: string;
  } | null;
};

export type Catalog = {
  categories: { id: string; name: string; slug: string; position: number }[];
  models: CatalogModel[];
};

export async function getCatalog(organizationId: string): Promise<Catalog> {
  const db = getDb();
  const [categories, models, units, rates] = await Promise.all([
    db
      .select()
      .from(schema.machineCategory)
      .where(scoped(schema.machineCategory.organizationId, organizationId))
      .orderBy(asc(schema.machineCategory.position), asc(schema.machineCategory.name)),
    db
      .select()
      .from(schema.machineModel)
      .where(scoped(schema.machineModel.organizationId, organizationId))
      .orderBy(asc(schema.machineModel.name)),
    db
      .select()
      .from(schema.machineUnit)
      .where(scoped(schema.machineUnit.organizationId, organizationId))
      .orderBy(asc(schema.machineUnit.internalCode)),
    db
      .select()
      .from(schema.rateCard)
      .where(scoped(schema.rateCard.organizationId, organizationId))
      .orderBy(desc(schema.rateCard.validFrom)),
  ]);

  const now = Date.now();
  return {
    categories: categories.map((c) => ({
      id: c.id,
      name: c.name,
      slug: c.slug,
      position: c.position,
    })),
    models: models.map((m) => {
      // La vigente: la más reciente ya iniciada y sin cerrar (lista ordenada desc).
      const current = rates.find(
        (r) =>
          r.modelId === m.id &&
          r.validFrom.getTime() <= now &&
          (r.validTo === null || r.validTo.getTime() > now)
      );
      return {
        id: m.id,
        categoryId: m.categoryId,
        name: m.name,
        brand: m.brand,
        specs: (m.specs ?? {}) as Record<string, unknown>,
        description: m.description,
        photos: (m.photos ?? []) as string[],
        requiresOperator: m.requiresOperator,
        active: m.active,
        units: units
          .filter((u) => u.modelId === m.id)
          .map((u) => ({
            id: u.id,
            internalCode: u.internalCode,
            year: u.year,
            usageHours: u.usageHours,
            status: u.status,
            notes: u.notes,
          })),
        currentRate: current
          ? {
              id: current.id,
              dailyCents: current.dailyCents,
              weeklyCents: current.weeklyCents,
              monthlyCents: current.monthlyCents,
              transferBaseCents: current.transferBaseCents,
              transferPerKmCents: current.transferPerKmCents,
              operatorDailyCents: current.operatorDailyCents,
              validFrom: current.validFrom.toISOString(),
            }
          : null,
      };
    }),
  };
}

export type RentalListItem = {
  id: string;
  kind: "alquiler" | "mantenimiento";
  status: "tentativa" | "confirmada" | "en_curso" | "finalizada" | "cancelada";
  from: string;
  to: string;
  expiresAt: string | null;
  createdBy: "agente" | "humano";
  quotedAmountCents: number | null;
  withTransfer: boolean;
  siteLocation: string | null;
  notes: string | null;
  isTest: boolean;
  unit: { id: string; internalCode: string };
  model: { id: string; name: string };
  contact: { id: string; name: string | null } | null;
  conversationId: string | null;
  createdAt: string;
};

export type RentalFilters = {
  status?: RentalListItem["status"][];
  unitId?: string;
  contactId?: string;
};

export async function listRentals(
  organizationId: string,
  filters: RentalFilters = {}
): Promise<RentalListItem[]> {
  const db = getDb();
  const rows = await db
    .select({
      rental: schema.rental,
      unitCode: schema.machineUnit.internalCode,
      modelId: schema.machineModel.id,
      modelName: schema.machineModel.name,
      contactName: schema.contact.name,
    })
    .from(schema.rental)
    .innerJoin(schema.machineUnit, eq(schema.rental.unitId, schema.machineUnit.id))
    .innerJoin(schema.machineModel, eq(schema.machineUnit.modelId, schema.machineModel.id))
    .leftJoin(schema.contact, eq(schema.rental.contactId, schema.contact.id))
    .where(
      scoped(
        schema.rental.organizationId,
        organizationId,
        filters.status && filters.status.length > 0
          ? inArray(schema.rental.status, filters.status)
          : undefined,
        filters.unitId ? eq(schema.rental.unitId, filters.unitId) : undefined,
        filters.contactId ? eq(schema.rental.contactId, filters.contactId) : undefined
      )
    )
    .orderBy(desc(schema.rental.createdAt));

  return rows.map((r) => ({
    id: r.rental.id,
    kind: r.rental.kind,
    status: r.rental.status,
    from: r.rental.period.from.toISOString(),
    to: r.rental.period.to.toISOString(),
    expiresAt: r.rental.expiresAt?.toISOString() ?? null,
    createdBy: r.rental.createdBy,
    quotedAmountCents: r.rental.quotedAmountCents,
    withTransfer: r.rental.withTransfer,
    siteLocation: r.rental.siteLocation,
    notes: r.rental.notes,
    isTest: r.rental.isTest,
    unit: { id: r.rental.unitId, internalCode: r.unitCode },
    model: { id: r.modelId, name: r.modelName },
    contact: r.rental.contactId ? { id: r.rental.contactId, name: r.contactName } : null,
    conversationId: r.rental.conversationId,
    createdAt: r.rental.createdAt.toISOString(),
  }));
}

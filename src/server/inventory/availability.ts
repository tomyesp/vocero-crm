import { and, asc, eq, ne, notExists, sql } from "drizzle-orm";
import { getDb, schema } from "@/lib/db";
import { scoped } from "@/lib/db/tenant";

/**
 * 017 — Disponibilidad de flota. La regla de oro: la disponibilidad NUNCA se
 * almacena — se calcula siempre contra `rental`, así no existe el bug del
 * booleano desactualizado que promete una máquina ocupada.
 *
 * El buffer de traslado se suma al rango CONSULTADO (no al guardado): una
 * máquina que vuelve de otra obra el mismo día no está realmente disponible.
 *
 * 017 Fase 7 — `isTest` elige CONTRA QUÉ MUNDO se calcula. Son dos calendarios
 * disjuntos sobre la misma flota: el real (default) y el del Laboratorio. Un
 * mundo de prueba que mirara también las reservas reales sería inservible como
 * banco de pruebas — la misma persona daría verde hoy y rojo mañana según lo
 * que el dueño haya alquilado esa semana. Y a la inversa: ninguna corrida del
 * Lab puede hacer que un lead real vea ocupada una máquina que está libre.
 */

const DAY_MS = 24 * 60 * 60 * 1000;

/** Días de colchón antes y después del alquiler para el traslado. */
export const TRANSFER_BUFFER_DAYS = 1;

/** Estados de reserva que ocupan flota (espejo del WHERE del EXCLUDE). */
const BLOCKING = ["tentativa", "confirmada", "en_curso"] as const;

export type Period = { from: Date; to: Date };

function buffered(period: Period, bufferDays: number): Period {
  return {
    from: new Date(period.from.getTime() - bufferDays * DAY_MS),
    to: new Date(period.to.getTime() + bufferDays * DAY_MS),
  };
}

/** `NOT EXISTS` de reserva activa que solape el rango (con buffer aplicado). */
function noActiveOverlap(
  unitIdColumn: typeof schema.machineUnit.id,
  range: Period,
  isTest: boolean
) {
  return notExists(
    getDb()
      .select({ one: sql`1` })
      .from(schema.rental)
      .where(
        and(
          eq(schema.rental.unitId, unitIdColumn),
          sql`${schema.rental.status} in ('tentativa','confirmada','en_curso')`,
          eq(schema.rental.isTest, isTest),
          sql`${schema.rental.period} && tstzrange(${range.from.toISOString()}, ${range.to.toISOString()})`
        )
      )
  );
}

/**
 * Unidades operativas del modelo libres en el rango (buffer incluido),
 * ordenadas por MENOS horas de uso: la flota rota pareja en vez de fundir
 * siempre la misma máquina.
 */
export async function findAvailableUnits(
  organizationId: string,
  modelId: string,
  period: Period,
  bufferDays: number = TRANSFER_BUFFER_DAYS,
  isTest: boolean = false
): Promise<(typeof schema.machineUnit.$inferSelect)[]> {
  const db = getDb();
  const range = buffered(period, bufferDays);
  return db
    .select()
    .from(schema.machineUnit)
    .where(
      scoped(
        schema.machineUnit.organizationId,
        organizationId,
        eq(schema.machineUnit.modelId, modelId),
        eq(schema.machineUnit.status, "operativa"),
        noActiveOverlap(schema.machineUnit.id, range, isTest)
      )
    )
    .orderBy(asc(schema.machineUnit.usageHours));
}

/**
 * La primera fecha en la que ALGUNA unidad del modelo puede cubrir la
 * duración pedida. Escaneo en memoria sobre las reservas activas de los
 * próximos meses: pocas unidades por modelo, pocas reservas por unidad —
 * no vale la pena hacerlo en SQL.
 */
export async function nextFreeDate(
  organizationId: string,
  modelId: string,
  fromDate: Date,
  durationDays: number,
  bufferDays: number = TRANSFER_BUFFER_DAYS,
  horizonDays: number = 90,
  isTest: boolean = false
): Promise<Date | null> {
  const db = getDb();
  const units = await db
    .select({ id: schema.machineUnit.id })
    .from(schema.machineUnit)
    .where(
      scoped(
        schema.machineUnit.organizationId,
        organizationId,
        eq(schema.machineUnit.modelId, modelId),
        eq(schema.machineUnit.status, "operativa")
      )
    );
  if (units.length === 0) return null;

  const rentals = await db
    .select({ unitId: schema.rental.unitId, period: schema.rental.period })
    .from(schema.rental)
    .where(
      scoped(
        schema.rental.organizationId,
        organizationId,
        sql`${schema.rental.status} in ('tentativa','confirmada','en_curso')`,
        eq(schema.rental.isTest, isTest)
      )
    );
  const byUnit = new Map<string, Period[]>();
  for (const r of rentals) {
    const list = byUnit.get(r.unitId) ?? [];
    list.push(r.period);
    byUnit.set(r.unitId, list);
  }

  const spanMs = (durationDays + 2 * bufferDays) * DAY_MS;
  for (let d = 0; d <= horizonDays; d++) {
    const start = new Date(fromDate.getTime() + d * DAY_MS);
    const candidate: Period = {
      from: new Date(start.getTime() - bufferDays * DAY_MS),
      to: new Date(start.getTime() - bufferDays * DAY_MS + spanMs),
    };
    const free = units.some((u) => {
      const busy = byUnit.get(u.id) ?? [];
      return busy.every((b) => b.to <= candidate.from || b.from >= candidate.to);
    });
    if (free) return start;
  }
  return null;
}

export type Alternative = {
  modelId: string;
  name: string;
  brand: string | null;
  unitId: string;
};

/**
 * Modelos activos de la MISMA categoría con una unidad libre en el rango —
 * lo que se le ofrece a un lead cuando su primera opción está tomada. Un
 * "no hay" seco pierde el lead; una alternativa concreta lo retiene.
 */
export async function findAlternatives(
  organizationId: string,
  categoryId: string,
  excludeModelId: string,
  period: Period,
  bufferDays: number = TRANSFER_BUFFER_DAYS,
  isTest: boolean = false
): Promise<Alternative[]> {
  const db = getDb();
  const range = buffered(period, bufferDays);
  const rows = await db
    .select({
      modelId: schema.machineModel.id,
      name: schema.machineModel.name,
      brand: schema.machineModel.brand,
      unitId: schema.machineUnit.id,
      usageHours: schema.machineUnit.usageHours,
    })
    .from(schema.machineUnit)
    .innerJoin(
      schema.machineModel,
      eq(schema.machineUnit.modelId, schema.machineModel.id)
    )
    .where(
      scoped(
        schema.machineUnit.organizationId,
        organizationId,
        eq(schema.machineModel.categoryId, categoryId),
        eq(schema.machineModel.active, true),
        ne(schema.machineModel.id, excludeModelId),
        eq(schema.machineUnit.status, "operativa"),
        noActiveOverlap(schema.machineUnit.id, range, isTest)
      )
    )
    .orderBy(asc(schema.machineUnit.usageHours));

  // Una unidad por modelo (la de menos horas): el lead elige modelo, no chapa.
  const seen = new Set<string>();
  const out: Alternative[] = [];
  for (const r of rows) {
    if (seen.has(r.modelId)) continue;
    seen.add(r.modelId);
    out.push({ modelId: r.modelId, name: r.name, brand: r.brand, unitId: r.unitId });
  }
  return out;
}

export { BLOCKING };

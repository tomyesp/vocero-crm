import { and, eq, inArray } from "drizzle-orm";
import { getDb, schema } from "@/lib/db";
import { newId } from "@/lib/db/ids";
import { scoped } from "@/lib/db/tenant";
import { labWindow, type LabWindow } from "@/server/lab/personas";

/**
 * 017 Fase 7 — El mundo de la corrida.
 *
 * La persona `fechas_ocupadas` solo prueba algo si la máquina que pide está de
 * verdad ocupada. Y "ocupada de verdad" no puede significar tocar el calendario
 * real: si el Lab bloqueara una retro para probarse a sí mismo, un lead real
 * escuchando "no hay" sería el precio de la prueba.
 *
 * Por eso el Laboratorio corre sobre un calendario propio (`rental.isTest`),
 * disjunto del real en las dos direcciones — ver `availability.ts`. Acá se
 * arma ese calendario: se borra el de la corrida anterior y se bloquea el
 * modelo objetivo en la ventana de la corrida.
 *
 * Se limpia AL EMPEZAR y no al terminar: si una corrida se cae a la mitad, lo
 * que dejó sirve para entender por qué, y la próxima arranca limpia igual.
 */

export type LabFixtures = {
  window: LabWindow;
  /** Modelo que quedó ocupado (null si el catálogo no tiene retroexcavadoras). */
  blockedModel: { id: string; name: string } | null;
  blockedUnits: number;
};

/**
 * Borra TODO rastro del mundo de pruebas: reservas y ofertas de prueba de
 * corridas anteriores. Las ofertas se limpian por las conversaciones de
 * prueba, que es donde viven.
 */
async function resetTestWorld(organizationId: string): Promise<void> {
  const db = getDb();
  await db
    .delete(schema.rental)
    .where(scoped(schema.rental.organizationId, organizationId, eq(schema.rental.isTest, true)));

  const testConvs = await db
    .select({ id: schema.conversation.id })
    .from(schema.conversation)
    .where(
      scoped(
        schema.conversation.organizationId,
        organizationId,
        eq(schema.conversation.isTest, true)
      )
    );
  if (testConvs.length > 0) {
    await db.delete(schema.rentalOffer).where(
      and(
        eq(schema.rentalOffer.organizationId, organizationId),
        inArray(
          schema.rentalOffer.conversationId,
          testConvs.map((c) => c.id)
        )
      )
    );
  }
}

/**
 * El modelo que la persona `fechas_ocupadas` va a pedir: una retroexcavadora
 * CAT. Se resuelve por catálogo y no por id fijo — el dueño renombra y agrega
 * máquinas, y un fixture con ids hardcodeados se rompe el día que lo haga.
 *
 * Si hay más de una retro, se bloquea SOLO la pedida: la otra queda libre y es
 * la alternativa legítima que el agente debería ofrecer. Ese es el
 * comportamiento que se está evaluando, no el "no hay" a secas.
 */
async function pickBlockedModel(
  organizationId: string
): Promise<{ id: string; name: string } | null> {
  const db = getDb();
  const rows = await db
    .select({ id: schema.machineModel.id, name: schema.machineModel.name })
    .from(schema.machineModel)
    .innerJoin(
      schema.machineCategory,
      eq(schema.machineModel.categoryId, schema.machineCategory.id)
    )
    .where(
      scoped(
        schema.machineModel.organizationId,
        organizationId,
        eq(schema.machineCategory.slug, "retroexcavadoras"),
        eq(schema.machineModel.active, true)
      )
    );
  if (rows.length === 0) return null;
  // La CAT si está (es la que nombra el guion); si no, la primera de la
  // categoría: la persona pide "una retroexcavadora CAT" y el agente tiene que
  // resolver contra el catálogo real de todos modos.
  const cat = rows.find(
    (r) => /\bcat\b/i.test(r.name) || /caterpillar/i.test(r.name)
  );
  return cat ?? rows[0]!;
}

/** Deja el mundo de pruebas listo para una corrida. */
export async function prepareTestWorld(
  organizationId: string,
  now: Date = new Date()
): Promise<LabFixtures> {
  await resetTestWorld(organizationId);

  const db = getDb();
  const window = labWindow(now);
  const model = await pickBlockedModel(organizationId);
  if (!model) return { window, blockedModel: null, blockedUnits: 0 };

  const units = await db
    .select({ id: schema.machineUnit.id })
    .from(schema.machineUnit)
    .where(
      scoped(
        schema.machineUnit.organizationId,
        organizationId,
        eq(schema.machineUnit.modelId, model.id),
        eq(schema.machineUnit.status, "operativa")
      )
    );
  if (units.length === 0) return { window, blockedModel: model, blockedUnits: 0 };

  // El bloqueo se extiende un día a cada lado de la ventana: sin eso, el
  // buffer de traslado dejaría la máquina "libre" para un rango pegado y la
  // persona podría recibir una oferta que el guion no espera.
  const DAY_MS = 24 * 60 * 60 * 1000;
  await db.insert(schema.rental).values(
    units.map((u) => ({
      id: newId("rental"),
      organizationId,
      unitId: u.id,
      kind: "alquiler" as const,
      period: {
        from: new Date(window.from.getTime() - DAY_MS),
        to: new Date(window.to.getTime() + DAY_MS),
      },
      status: "confirmada" as const,
      createdBy: "humano" as const,
      isTest: true,
      notes: "[Laboratorio] Bloqueo de la corrida: la persona fechas_ocupadas necesita esta máquina tomada.",
    }))
  );

  return { window, blockedModel: model, blockedUnits: units.length };
}

/** Solo para el reporte: describe en una línea el mundo que se armó. */
export function describeFixtures(f: LabFixtures): string {
  if (!f.blockedModel) {
    return "Sin retroexcavadoras en el catálogo: la persona de fechas ocupadas corrió contra flota libre.";
  }
  if (f.blockedUnits === 0) {
    return `${f.blockedModel.name} no tiene unidades operativas: no hizo falta bloquearla.`;
  }
  return `${f.blockedModel.name}: ${f.blockedUnits} unidad(es) ocupada(s) durante la ventana de la corrida.`;
}

import { and, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import { apiError, parseBody, withAuth } from "@/lib/api";
import { getDb, schema } from "@/lib/db";
import { scoped } from "@/lib/db/tenant";
import { publish } from "@/server/events/bus";
import { inventoryDisabledResponse, inventoryEnabled } from "@/server/inventory/flag";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ id: string }> };

/**
 * 017 — Transiciones HUMANAS de una reserva. Esta división es innegociable:
 * el agente solo crea tentativas por /api/bot/*; confirmar, cancelar,
 * iniciar y finalizar viven acá, detrás del login.
 *
 * El UPDATE condicional por estado hace la transición atómica: si dos
 * personas tocan la misma reserva, gana una y la otra recibe el conflicto.
 */
const patchSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("confirmar") }),
  z.object({ action: z.literal("cancelar") }),
  z.object({ action: z.literal("iniciar") }),
  z.object({ action: z.literal("finalizar") }),
  z.object({ action: z.literal("notas"), notes: z.string().trim().max(1000) }),
]);

/** Desde qué estados es legal cada transición. */
const TRANSITIONS: Record<string, { fromStatuses: string[]; toStatus: string }> = {
  confirmar: { fromStatuses: ["tentativa"], toStatus: "confirmada" },
  cancelar: { fromStatuses: ["tentativa", "confirmada", "en_curso"], toStatus: "cancelada" },
  iniciar: { fromStatuses: ["confirmada"], toStatus: "en_curso" },
  finalizar: { fromStatuses: ["en_curso"], toStatus: "finalizada" },
};

export const PATCH = withAuth(async (session, req: Request, ctx: Params) => {
  if (!inventoryEnabled()) return inventoryDisabledResponse();
  const { id } = await ctx.params;
  const body = await parseBody(req, patchSchema);
  if (!body.ok) return body.response;

  const db = getDb();

  if (body.data.action === "notas") {
    const updated = await db
      .update(schema.rental)
      .set({ notes: body.data.notes, updatedAt: new Date() })
      .where(scoped(schema.rental.organizationId, session.organizationId, eq(schema.rental.id, id)))
      .returning();
    if (!updated[0]) return apiError(404, "not_found", "Reserva inexistente");
    return Response.json({ rental: updated[0] });
  }

  const transition = TRANSITIONS[body.data.action]!;
  const updated = await db
    .update(schema.rental)
    .set({
      status: transition.toStatus as typeof schema.rental.$inferSelect.status,
      // Confirmada deja de expirar; el resto conserva su historia.
      ...(body.data.action === "confirmar" ? { expiresAt: null } : {}),
      updatedAt: new Date(),
    })
    .where(
      and(
        scoped(schema.rental.organizationId, session.organizationId, eq(schema.rental.id, id)),
        inArray(
          schema.rental.status,
          transition.fromStatuses as (typeof schema.rental.$inferSelect.status)[]
        )
      )
    )
    .returning();

  const rental = updated[0];
  if (!rental) {
    // Existe pero en otro estado, o no existe: distinguir para el operador.
    const rows = await db
      .select({ status: schema.rental.status })
      .from(schema.rental)
      .where(scoped(schema.rental.organizationId, session.organizationId, eq(schema.rental.id, id)))
      .limit(1);
    if (!rows[0]) return apiError(404, "not_found", "Reserva inexistente");
    return apiError(
      409,
      "transicion_invalida",
      `No se puede ${body.data.action} una reserva ${rows[0].status}`
    );
  }

  publish(session.organizationId, { type: "rental.updated", data: { rentalId: rental.id } });
  return Response.json({ rental });
});

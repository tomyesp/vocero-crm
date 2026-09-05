import { eq } from "drizzle-orm";
import { z } from "zod";
import { apiError, parseBody, withAuth } from "@/lib/api";
import { getDb, schema } from "@/lib/db";
import { scoped } from "@/lib/db/tenant";
import { inventoryDisabledResponse, inventoryEnabled } from "@/server/inventory/flag";
import { computeQuote, getCurrentRate } from "@/server/inventory/quote";

export const dynamic = "force-dynamic";

const postSchema = z.object({
  modelId: z.string().trim().min(1),
  days: z.number().int().min(1).max(365),
  hoursPerDay: z.number().min(0.5).max(24),
  withTransfer: z.boolean().optional(),
  km: z.number().min(0).max(2000).optional(),
});

/**
 * 017 — Simulador de cotización de la UI. Llama EXACTAMENTE la misma función
 * que el endpoint del bot: lo que ve el dueño acá es lo que dice el agente.
 */
export const POST = withAuth(async (session, req: Request) => {
  if (!inventoryEnabled()) return inventoryDisabledResponse();
  const body = await parseBody(req, postSchema);
  if (!body.ok) return body.response;

  const db = getDb();
  const models = await db
    .select({ id: schema.machineModel.id })
    .from(schema.machineModel)
    .where(scoped(schema.machineModel.organizationId, session.organizationId, eq(schema.machineModel.id, body.data.modelId)))
    .limit(1);
  if (!models[0]) return apiError(404, "not_found", "Modelo inexistente");

  const rate = await getCurrentRate(session.organizationId, body.data.modelId);
  if (!rate) return apiError(409, "sin_tarifa", "El modelo no tiene tarifa vigente");

  const quote = computeQuote(rate, {
    days: body.data.days,
    hoursPerDay: body.data.hoursPerDay,
    withTransfer: body.data.withTransfer ?? false,
    km: body.data.km,
  });
  return Response.json({ quote });
});

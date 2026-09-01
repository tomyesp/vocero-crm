import { eq } from "drizzle-orm";
import { z } from "zod";
import { apiError, parseBody, withAuth } from "@/lib/api";
import { getDb, schema } from "@/lib/db";
import { scoped } from "@/lib/db/tenant";
import { inventoryDisabledResponse, inventoryEnabled } from "@/server/inventory/flag";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ id: string }> };

const patchSchema = z.object({
  internalCode: z.string().trim().min(1).max(40).optional(),
  year: z.number().int().min(1970).max(2100).nullable().optional(),
  usageHours: z.number().int().min(0).optional(),
  status: z.enum(["operativa", "mantenimiento", "baja"]).optional(),
  notes: z.string().trim().max(1000).nullable().optional(),
});

export const PATCH = withAuth(async (session, req: Request, ctx: Params) => {
  if (!inventoryEnabled()) return inventoryDisabledResponse();
  const { id } = await ctx.params;
  const body = await parseBody(req, patchSchema);
  if (!body.ok) return body.response;

  const db = getDb();
  const updated = await db
    .update(schema.machineUnit)
    .set({ ...body.data, updatedAt: new Date() })
    .where(scoped(schema.machineUnit.organizationId, session.organizationId, eq(schema.machineUnit.id, id)))
    .returning();
  if (!updated[0]) return apiError(404, "not_found", "Unidad inexistente");
  return Response.json({ unit: updated[0] });
});

export const DELETE = withAuth(async (session, _req: Request, ctx: Params) => {
  if (!inventoryEnabled()) return inventoryDisabledResponse();
  const { id } = await ctx.params;
  const db = getDb();
  try {
    const deleted = await db
      .delete(schema.machineUnit)
      .where(scoped(schema.machineUnit.organizationId, session.organizationId, eq(schema.machineUnit.id, id)))
      .returning({ id: schema.machineUnit.id });
    if (!deleted[0]) return apiError(404, "not_found", "Unidad inexistente");
    return Response.json({ ok: true });
  } catch (err) {
    const code = (err as { code?: string })?.code ?? (err as { cause?: { code?: string } })?.cause?.code;
    if (code === "23503") {
      // Tiene reservas (RESTRICT): la historia no se borra — se da de baja.
      return apiError(409, "unidad_con_reservas", "La unidad tiene reservas; marcala como baja en vez de borrarla");
    }
    throw err;
  }
});

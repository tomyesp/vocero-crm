import { eq } from "drizzle-orm";
import { z } from "zod";
import { apiError, parseBody, withAuth } from "@/lib/api";
import { getDb, schema } from "@/lib/db";
import { scoped } from "@/lib/db/tenant";
import { inventoryDisabledResponse, inventoryEnabled } from "@/server/inventory/flag";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ id: string }> };

const patchSchema = z.object({
  categoryId: z.string().trim().min(1).optional(),
  name: z.string().trim().min(1).max(120).optional(),
  brand: z.string().trim().max(60).nullable().optional(),
  description: z.string().trim().max(2000).nullable().optional(),
  specs: z.record(z.unknown()).optional(),
  photos: z.array(z.string()).max(12).optional(),
  requiresOperator: z.boolean().optional(),
  active: z.boolean().optional(),
});

export const PATCH = withAuth(async (session, req: Request, ctx: Params) => {
  if (!inventoryEnabled()) return inventoryDisabledResponse();
  const { id } = await ctx.params;
  const body = await parseBody(req, patchSchema);
  if (!body.ok) return body.response;

  const db = getDb();
  const updated = await db
    .update(schema.machineModel)
    .set({ ...body.data, updatedAt: new Date() })
    .where(scoped(schema.machineModel.organizationId, session.organizationId, eq(schema.machineModel.id, id)))
    .returning();
  if (!updated[0]) return apiError(404, "not_found", "Modelo inexistente");
  return Response.json({ model: updated[0] });
});

export const DELETE = withAuth(async (session, _req: Request, ctx: Params) => {
  if (!inventoryEnabled()) return inventoryDisabledResponse();
  const { id } = await ctx.params;
  const db = getDb();
  try {
    const deleted = await db
      .delete(schema.machineModel)
      .where(scoped(schema.machineModel.organizationId, session.organizationId, eq(schema.machineModel.id, id)))
      .returning({ id: schema.machineModel.id });
    if (!deleted[0]) return apiError(404, "not_found", "Modelo inexistente");
    return Response.json({ ok: true });
  } catch (err) {
    const code = (err as { code?: string })?.code ?? (err as { cause?: { code?: string } })?.cause?.code;
    if (code === "23503") {
      return apiError(409, "modelo_con_unidades", "Dá de baja o borrá las unidades antes de borrar el modelo");
    }
    throw err;
  }
});

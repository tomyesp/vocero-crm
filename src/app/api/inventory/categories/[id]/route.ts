import { eq } from "drizzle-orm";
import { z } from "zod";
import { apiError, parseBody, withAuth } from "@/lib/api";
import { getDb, schema } from "@/lib/db";
import { scoped } from "@/lib/db/tenant";
import { inventoryDisabledResponse, inventoryEnabled } from "@/server/inventory/flag";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ id: string }> };

const patchSchema = z.object({
  name: z.string().trim().min(1).max(80).optional(),
  position: z.number().int().min(0).optional(),
});

export const PATCH = withAuth(async (session, req: Request, ctx: Params) => {
  if (!inventoryEnabled()) return inventoryDisabledResponse();
  const { id } = await ctx.params;
  const body = await parseBody(req, patchSchema);
  if (!body.ok) return body.response;

  const db = getDb();
  const updated = await db
    .update(schema.machineCategory)
    .set(body.data)
    .where(scoped(schema.machineCategory.organizationId, session.organizationId, eq(schema.machineCategory.id, id)))
    .returning();
  if (!updated[0]) return apiError(404, "not_found", "Categoría inexistente");
  return Response.json({ category: updated[0] });
});

export const DELETE = withAuth(async (session, _req: Request, ctx: Params) => {
  if (!inventoryEnabled()) return inventoryDisabledResponse();
  const { id } = await ctx.params;
  const db = getDb();
  try {
    const deleted = await db
      .delete(schema.machineCategory)
      .where(scoped(schema.machineCategory.organizationId, session.organizationId, eq(schema.machineCategory.id, id)))
      .returning({ id: schema.machineCategory.id });
    if (!deleted[0]) return apiError(404, "not_found", "Categoría inexistente");
    return Response.json({ ok: true });
  } catch (err) {
    // 23503: el RESTRICT del FK — la categoría tiene modelos vivos.
    const code = (err as { code?: string })?.code ?? (err as { cause?: { code?: string } })?.cause?.code;
    if (code === "23503") {
      return apiError(409, "categoria_con_modelos", "Vaciá la categoría antes de borrarla");
    }
    throw err;
  }
});

import { z } from "zod";
import { apiError, parseBody, withAuth } from "@/lib/api";
import { getDb, schema } from "@/lib/db";
import { newId } from "@/lib/db/ids";
import { inventoryDisabledResponse, inventoryEnabled } from "@/server/inventory/flag";

export const dynamic = "force-dynamic";

const postSchema = z.object({
  modelId: z.string().trim().min(1),
  internalCode: z.string().trim().min(1).max(40),
  year: z.number().int().min(1970).max(2100).nullable().optional(),
  usageHours: z.number().int().min(0).optional(),
  notes: z.string().trim().max(1000).optional(),
});

export const POST = withAuth(async (session, req: Request) => {
  if (!inventoryEnabled()) return inventoryDisabledResponse();
  const body = await parseBody(req, postSchema);
  if (!body.ok) return body.response;

  const db = getDb();
  try {
    const inserted = await db
      .insert(schema.machineUnit)
      .values({
        id: newId("machineUnit"),
        organizationId: session.organizationId,
        modelId: body.data.modelId,
        internalCode: body.data.internalCode,
        year: body.data.year ?? null,
        usageHours: body.data.usageHours ?? 0,
        notes: body.data.notes ?? null,
      })
      .returning();
    return Response.json({ unit: inserted[0] }, { status: 201 });
  } catch (err) {
    const code = (err as { code?: string })?.code ?? (err as { cause?: { code?: string } })?.cause?.code;
    if (code === "23505") {
      return apiError(409, "codigo_duplicado", "Ya existe una unidad con ese número interno");
    }
    throw err;
  }
});

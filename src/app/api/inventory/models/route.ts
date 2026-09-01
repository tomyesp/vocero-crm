import { z } from "zod";
import { parseBody, withAuth } from "@/lib/api";
import { getDb, schema } from "@/lib/db";
import { newId } from "@/lib/db/ids";
import { inventoryDisabledResponse, inventoryEnabled } from "@/server/inventory/flag";

export const dynamic = "force-dynamic";

const postSchema = z.object({
  categoryId: z.string().trim().min(1),
  name: z.string().trim().min(1).max(120),
  brand: z.string().trim().max(60).optional(),
  description: z.string().trim().max(2000).optional(),
  specs: z.record(z.unknown()).optional(),
  requiresOperator: z.boolean().optional(),
});

export const POST = withAuth(async (session, req: Request) => {
  if (!inventoryEnabled()) return inventoryDisabledResponse();
  const body = await parseBody(req, postSchema);
  if (!body.ok) return body.response;

  const db = getDb();
  const inserted = await db
    .insert(schema.machineModel)
    .values({
      id: newId("machineModel"),
      organizationId: session.organizationId,
      categoryId: body.data.categoryId,
      name: body.data.name,
      brand: body.data.brand ?? null,
      description: body.data.description ?? null,
      specs: body.data.specs ?? {},
      requiresOperator: body.data.requiresOperator ?? false,
    })
    .returning();
  return Response.json({ model: inserted[0] }, { status: 201 });
});

import { z } from "zod";
import { parseBody, withAuth } from "@/lib/api";
import { getDb, schema } from "@/lib/db";
import { newId } from "@/lib/db/ids";
import { inventoryDisabledResponse, inventoryEnabled } from "@/server/inventory/flag";

export const dynamic = "force-dynamic";

const postSchema = z.object({
  name: z.string().trim().min(1).max(80),
  position: z.number().int().min(0).optional(),
});

function slugify(name: string): string {
  return name
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

export const POST = withAuth(async (session, req: Request) => {
  if (!inventoryEnabled()) return inventoryDisabledResponse();
  const body = await parseBody(req, postSchema);
  if (!body.ok) return body.response;

  const db = getDb();
  const inserted = await db
    .insert(schema.machineCategory)
    .values({
      id: newId("machineCategory"),
      organizationId: session.organizationId,
      name: body.data.name,
      slug: slugify(body.data.name),
      position: body.data.position ?? 0,
    })
    .returning();
  return Response.json({ category: inserted[0] }, { status: 201 });
});

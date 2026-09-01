import { eq } from "drizzle-orm";
import { apiError, withAuth } from "@/lib/api";
import { getDb, schema } from "@/lib/db";
import { newId } from "@/lib/db/ids";
import { scoped } from "@/lib/db/tenant";
import { saveMediaFile } from "@/server/whatsapp/media";
import { inventoryDisabledResponse, inventoryEnabled } from "@/server/inventory/flag";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ id: string }> };

const PHOTO_MIMES = new Set(["image/jpeg", "image/png", "image/webp"]);
const MAX_BYTES = 5 * 1024 * 1024;

/**
 * 017 — Foto del catálogo. Storage LOCAL vía `mediaAsset` (constitución II:
 * sin terceros); se sirve por `/api/media/{assetId}` como cualquier adjunto.
 */
export const POST = withAuth(async (session, req: Request, ctx: Params) => {
  if (!inventoryEnabled()) return inventoryDisabledResponse();
  const { id } = await ctx.params;

  const form = await req.formData().catch(() => null);
  const file = form?.get("file");
  if (!(file instanceof File)) return apiError(422, "invalid_body", "Falta el archivo");
  if (!PHOTO_MIMES.has(file.type)) return apiError(422, "invalid_mime", "Solo JPG, PNG o WebP");
  if (file.size > MAX_BYTES) return apiError(422, "too_large", "Máximo 5 MB");

  const db = getDb();
  const models = await db
    .select({ id: schema.machineModel.id, photos: schema.machineModel.photos })
    .from(schema.machineModel)
    .where(scoped(schema.machineModel.organizationId, session.organizationId, eq(schema.machineModel.id, id)))
    .limit(1);
  const model = models[0];
  if (!model) return apiError(404, "not_found", "Modelo inexistente");

  const assetId = newId("mediaAsset");
  const storagePath = await saveMediaFile(
    session.organizationId,
    assetId,
    Buffer.from(await file.arrayBuffer())
  );
  await db.insert(schema.mediaAsset).values({
    id: assetId,
    organizationId: session.organizationId,
    kind: "image",
    mimeType: file.type,
    fileName: file.name,
    fileSize: file.size,
    storagePath,
    fetchStatus: "available",
  });

  const photos = [...((model.photos ?? []) as string[]), assetId];
  await db
    .update(schema.machineModel)
    .set({ photos, updatedAt: new Date() })
    .where(scoped(schema.machineModel.organizationId, session.organizationId, eq(schema.machineModel.id, id)));

  return Response.json({ assetId, photos }, { status: 201 });
});

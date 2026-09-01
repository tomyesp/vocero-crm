import { and, desc, eq, isNull } from "drizzle-orm";
import { z } from "zod";
import { apiError, parseBody, withAuth } from "@/lib/api";
import { getDb, schema } from "@/lib/db";
import { newId } from "@/lib/db/ids";
import { scoped } from "@/lib/db/tenant";
import { inventoryDisabledResponse, inventoryEnabled } from "@/server/inventory/flag";

export const dynamic = "force-dynamic";

/** 017 — Historial de tarifas de un modelo (la vigente primero). */
export const GET = withAuth(async (session, req: Request) => {
  if (!inventoryEnabled()) return inventoryDisabledResponse();
  const modelId = new URL(req.url).searchParams.get("modelId");
  if (!modelId) return apiError(422, "invalid_query", "Falta modelId");

  const db = getDb();
  const rates = await db
    .select()
    .from(schema.rateCard)
    .where(scoped(schema.rateCard.organizationId, session.organizationId, eq(schema.rateCard.modelId, modelId)))
    .orderBy(desc(schema.rateCard.validFrom));
  return Response.json({ rates });
});

const postSchema = z.object({
  modelId: z.string().trim().min(1),
  dailyCents: z.number().int().min(0),
  weeklyCents: z.number().int().min(0).nullable().optional(),
  monthlyCents: z.number().int().min(0).nullable().optional(),
  transferBaseCents: z.number().int().min(0).optional(),
  transferPerKmCents: z.number().int().min(0).optional(),
  operatorDailyCents: z.number().int().min(0).optional(),
});

/**
 * Tarifa nueva = HISTÓRICO: cierra la vigente (validTo = ahora) e inserta la
 * nueva con validFrom = ahora, en una transacción. Nunca se sobrescribe una
 * fila — una cotización vieja siempre se explica con la tarifa de su día.
 */
export const POST = withAuth(async (session, req: Request) => {
  if (!inventoryEnabled()) return inventoryDisabledResponse();
  const body = await parseBody(req, postSchema);
  if (!body.ok) return body.response;

  const db = getDb();
  const now = new Date();
  const rate = await db.transaction(async (tx) => {
    await tx
      .update(schema.rateCard)
      .set({ validTo: now })
      .where(
        and(
          scoped(
            schema.rateCard.organizationId,
            session.organizationId,
            eq(schema.rateCard.modelId, body.data.modelId)
          ),
          isNull(schema.rateCard.validTo)
        )
      );
    const inserted = await tx
      .insert(schema.rateCard)
      .values({
        id: newId("rateCard"),
        organizationId: session.organizationId,
        modelId: body.data.modelId,
        dailyCents: body.data.dailyCents,
        weeklyCents: body.data.weeklyCents ?? null,
        monthlyCents: body.data.monthlyCents ?? null,
        transferBaseCents: body.data.transferBaseCents ?? 0,
        transferPerKmCents: body.data.transferPerKmCents ?? 0,
        operatorDailyCents: body.data.operatorDailyCents ?? 0,
        validFrom: now,
      })
      .returning();
    return inserted[0]!;
  });
  return Response.json({ rate }, { status: 201 });
});

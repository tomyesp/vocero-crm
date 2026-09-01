import { and, eq, isNull } from "drizzle-orm";
import { getDb, schema } from "@/lib/db";
import { newId } from "@/lib/db/ids";
import { scoped } from "@/lib/db/tenant";
import type { Period } from "@/server/inventory/availability";

/**
 * 017 — Emisión y consumo de ofertas de alquiler, calcando el protocolo de
 * `agenda/offers.ts`: sin fila aquí no hay reserva. La oferta expira a los
 * 30 minutos y se consume UNA sola vez; el LLM solo puede elegir un
 * `offerId` que este servidor emitió en ESA conversación.
 */

export const OFFER_TTL_MS = 30 * 60 * 1000;

export type IssuedOffer = {
  offerId: string;
  modelId: string;
  unitId: string;
  period: Period;
  quotedAmountCents: number;
  label: string;
  expiresAt: Date;
};

export type OfferDraft = {
  modelId: string;
  unitId: string;
  period: Period;
  quotedAmountCents: number;
  /** La etiqueta EXACTA que verá el cliente; la reserva la hereda. */
  label: string;
};

/**
 * Reemplaza la oferta vigente de la conversación (la válida es siempre la
 * última ronda) e inserta la nueva. Las consumidas no se tocan: son historia
 * de reservas reales.
 */
export async function replaceRentalOffers(
  organizationId: string,
  conversationId: string,
  drafts: OfferDraft[]
): Promise<IssuedOffer[]> {
  const db = getDb();
  const expiresAt = new Date(Date.now() + OFFER_TTL_MS);
  const rows = drafts.map((d) => ({
    id: newId("rentalOffer"),
    organizationId,
    conversationId,
    modelId: d.modelId,
    unitId: d.unitId,
    period: d.period,
    quotedAmountCents: d.quotedAmountCents,
    label: d.label,
    expiresAt,
  }));
  await db.transaction(async (tx) => {
    await tx
      .delete(schema.rentalOffer)
      .where(
        scoped(
          schema.rentalOffer.organizationId,
          organizationId,
          eq(schema.rentalOffer.conversationId, conversationId),
          isNull(schema.rentalOffer.consumedAt)
        )
      );
    if (rows.length > 0) await tx.insert(schema.rentalOffer).values(rows);
  });
  return rows.map((r) => ({
    offerId: r.id,
    modelId: r.modelId,
    unitId: r.unitId,
    period: r.period,
    quotedAmountCents: r.quotedAmountCents,
    label: r.label,
    expiresAt,
  }));
}

export type OfferValidation =
  | { ok: true; offer: typeof schema.rentalOffer.$inferSelect }
  | { ok: false; reason: "oferta_desconocida" | "oferta_vencida" };

/**
 * Valida un offerId contra SU conversación. La distinción de motivos importa
 * para el LLM: `oferta_vencida` se arregla re-consultando disponibilidad;
 * `oferta_desconocida` es un id alucinado o ajeno y merece el reto completo.
 */
export async function validateOffer(
  organizationId: string,
  conversationId: string,
  offerId: string,
  now: Date = new Date()
): Promise<OfferValidation> {
  const db = getDb();
  const rows = await db
    .select()
    .from(schema.rentalOffer)
    .where(scoped(schema.rentalOffer.organizationId, organizationId, eq(schema.rentalOffer.id, offerId)))
    .limit(1);
  const offer = rows[0];
  // Ajena a esta conversación == inexistente: no se filtra que el id existe.
  if (!offer || offer.conversationId !== conversationId || offer.consumedAt) {
    return { ok: false, reason: "oferta_desconocida" };
  }
  if (offer.expiresAt.getTime() <= now.getTime()) {
    return { ok: false, reason: "oferta_vencida" };
  }
  return { ok: true, offer };
}

/**
 * Consumo único y atómico: el UPDATE condicional (`consumed_at IS NULL`) es
 * el candado — dos reservas simultáneas de la misma oferta no pueden ganar
 * las dos, gane quien gane la fila.
 */
export async function consumeOffer(
  tx: Pick<ReturnType<typeof getDb>, "update">,
  organizationId: string,
  offerId: string
): Promise<boolean> {
  const updated = await tx
    .update(schema.rentalOffer)
    .set({ consumedAt: new Date() })
    .where(
      and(
        scoped(schema.rentalOffer.organizationId, organizationId, eq(schema.rentalOffer.id, offerId)),
        isNull(schema.rentalOffer.consumedAt)
      )
    )
    .returning({ id: schema.rentalOffer.id });
  return updated.length === 1;
}

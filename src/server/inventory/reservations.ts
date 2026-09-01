import { and, desc, eq } from "drizzle-orm";
import { getDb, schema } from "@/lib/db";
import { newId } from "@/lib/db/ids";
import { scoped } from "@/lib/db/tenant";
import { publish } from "@/server/events/bus";
import {
  findAlternatives,
  findAvailableUnits,
  type Period,
} from "@/server/inventory/availability";
import {
  consumeOffer,
  replaceRentalOffers,
  validateOffer,
  type IssuedOffer,
} from "@/server/inventory/offers";
import { getCurrentRate } from "@/server/inventory/quote";

/**
 * 017 — Creación y movimiento de reservas TENTATIVAS. El agente llega hasta
 * acá y no más: confirmar, cancelar y modificar son acciones humanas de UI.
 *
 * La carrera real la gana la BASE (constraint `rental_no_overlap`): entre
 * validar la oferta y escribir la reserva cabe otro lead, y cuando eso pasa
 * el 23P01 se traduce a `recien_tomada` CON alternativas frescas — el mismo
 * criterio que `slot_taken` en la agenda.
 */

/** Una tentativa sin confirmación humana se libera sola pasado este plazo. */
export const TENTATIVE_TTL_MS = 24 * 60 * 60 * 1000;

const DAY_MS = 24 * 60 * 60 * 1000;

/** Alternativa informativa de otra máquina (requiere re-consultar disponibilidad). */
export type ModelAlternative = {
  modelId: string;
  name: string;
  brand: string | null;
  dailyCents: number | null;
};

/** Error tipado; `code` mapea a HTTP en la capa de API (como SendError). */
export class RentalError extends Error {
  code:
    | "oferta_desconocida"
    | "oferta_vencida"
    | "recien_tomada"
    | "reserva_inexistente"
    | "conversacion_inexistente";
  /** `recien_tomada`: ofertas frescas de la MISMA máquina, reservables ya. */
  offers?: IssuedOffer[];
  /** `recien_tomada`: otras máquinas de la categoría (info, no reservables). */
  alternatives?: ModelAlternative[];

  constructor(code: RentalError["code"], message: string) {
    super(message);
    this.name = "RentalError";
    this.code = code;
  }
}

/** El 23P01 del EXCLUDE, venga pelado o envuelto por el driver en `cause`. */
function isExclusionViolation(err: unknown): boolean {
  const code =
    (err as { code?: string })?.code ??
    ((err as { cause?: { code?: string } })?.cause?.code);
  return code === "23P01";
}

function periodDays(period: Period): number {
  return Math.max(1, Math.round((period.to.getTime() - period.from.getTime()) / DAY_MS));
}

/**
 * Ante `recien_tomada`, armar la salida: si queda otra unidad del MISMO
 * modelo en el MISMO rango, se emiten ofertas nuevas (mismo precio: misma
 * tarifa) listas para reservar en el próximo turno; si no, se listan otras
 * máquinas de la categoría para re-consultar. Nunca un "no hay" seco.
 */
async function buildRaceRecovery(
  organizationId: string,
  conversationId: string,
  offer: typeof schema.rentalOffer.$inferSelect
): Promise<{ offers: IssuedOffer[]; alternatives: ModelAlternative[] }> {
  const db = getDb();
  const freeUnits = await findAvailableUnits(organizationId, offer.modelId, offer.period);
  if (freeUnits.length > 0) {
    const unit = freeUnits[0]!;
    const fresh = await replaceRentalOffers(organizationId, conversationId, [
      {
        modelId: offer.modelId,
        unitId: unit.id,
        period: offer.period,
        quotedAmountCents: offer.quotedAmountCents,
        label: offer.label,
      },
    ]);
    return { offers: fresh, alternatives: [] };
  }

  const models = await db
    .select({ categoryId: schema.machineModel.categoryId })
    .from(schema.machineModel)
    .where(scoped(schema.machineModel.organizationId, organizationId, eq(schema.machineModel.id, offer.modelId)))
    .limit(1);
  const categoryId = models[0]?.categoryId;
  if (!categoryId) return { offers: [], alternatives: [] };

  const alts = await findAlternatives(organizationId, categoryId, offer.modelId, offer.period);
  const out: ModelAlternative[] = [];
  for (const a of alts) {
    const rate = await getCurrentRate(organizationId, a.modelId);
    out.push({ modelId: a.modelId, name: a.name, brand: a.brand, dailyCents: rate?.dailyCents ?? null });
  }
  return { offers: [], alternatives: out };
}

async function loadConversation(organizationId: string, conversationId: string) {
  const db = getDb();
  const rows = await db
    .select({
      id: schema.conversation.id,
      contactId: schema.conversation.contactId,
      isTest: schema.conversation.isTest,
    })
    .from(schema.conversation)
    .where(scoped(schema.conversation.organizationId, organizationId, eq(schema.conversation.id, conversationId)))
    .limit(1);
  return rows[0] ?? null;
}

export type CreateTentativeInput = {
  organizationId: string;
  conversationId: string;
  offerId: string;
  createdBy: "agente" | "humano";
  siteLocation?: string;
  withTransfer?: boolean;
  notes?: string;
};

export async function createTentativeRental(
  input: CreateTentativeInput
): Promise<typeof schema.rental.$inferSelect> {
  const { organizationId, conversationId, offerId } = input;
  const db = getDb();

  const conversation = await loadConversation(organizationId, conversationId);
  if (!conversation) {
    throw new RentalError("conversacion_inexistente", "La conversación no existe");
  }

  const validation = await validateOffer(organizationId, conversationId, offerId);
  if (!validation.ok) {
    throw new RentalError(validation.reason, `Oferta rechazada: ${validation.reason}`);
  }
  const offer = validation.offer;

  try {
    const rental = await db.transaction(async (tx) => {
      // El UPDATE condicional es el candado del consumo único: si otra
      // petición consumió la oferta un instante antes, acá se corta.
      const consumed = await consumeOffer(tx, organizationId, offerId);
      if (!consumed) {
        throw new RentalError("oferta_desconocida", "La oferta ya fue consumida");
      }
      const inserted = await tx
        .insert(schema.rental)
        .values({
          id: newId("rental"),
          organizationId,
          unitId: offer.unitId,
          kind: "alquiler",
          contactId: conversation.contactId,
          conversationId,
          period: offer.period,
          status: "tentativa",
          expiresAt: new Date(Date.now() + TENTATIVE_TTL_MS),
          createdBy: input.createdBy,
          quotedAmountCents: offer.quotedAmountCents,
          withTransfer: input.withTransfer ?? false,
          siteLocation: input.siteLocation ?? null,
          isTest: conversation.isTest,
          notes: input.notes ?? null,
        })
        .returning();
      return inserted[0]!;
    });
    publish(organizationId, { type: "rental.updated", data: { rentalId: rental.id } });
    return rental;
  } catch (err) {
    if (!isExclusionViolation(err)) throw err;
    const recovery = await buildRaceRecovery(organizationId, conversationId, offer);
    const raceErr = new RentalError(
      "recien_tomada",
      "Otra reserva ganó esa unidad en ese rango"
    );
    raceErr.offers = recovery.offers;
    raceErr.alternatives = recovery.alternatives;
    throw raceErr;
  }
}

export type MoveTentativeInput = {
  organizationId: string;
  conversationId: string;
  offerId: string;
};

/**
 * Mueve LA tentativa de la conversación a otra oferta (PATCH del bot). Solo
 * tentativas: una reserva confirmada la mueve un humano desde la UI.
 */
export async function moveTentativeRental(
  input: MoveTentativeInput
): Promise<typeof schema.rental.$inferSelect> {
  const { organizationId, conversationId, offerId } = input;
  const db = getDb();

  const rows = await db
    .select()
    .from(schema.rental)
    .where(
      scoped(
        schema.rental.organizationId,
        organizationId,
        eq(schema.rental.conversationId, conversationId),
        eq(schema.rental.status, "tentativa")
      )
    )
    .orderBy(desc(schema.rental.createdAt))
    .limit(1);
  const current = rows[0];
  if (!current) {
    throw new RentalError("reserva_inexistente", "No hay tentativa que mover");
  }

  const validation = await validateOffer(organizationId, conversationId, offerId);
  if (!validation.ok) {
    throw new RentalError(validation.reason, `Oferta rechazada: ${validation.reason}`);
  }
  const offer = validation.offer;

  try {
    const rental = await db.transaction(async (tx) => {
      const consumed = await consumeOffer(tx, organizationId, offerId);
      if (!consumed) {
        throw new RentalError("oferta_desconocida", "La oferta ya fue consumida");
      }
      const updated = await tx
        .update(schema.rental)
        .set({
          unitId: offer.unitId,
          period: offer.period,
          quotedAmountCents: offer.quotedAmountCents,
          expiresAt: new Date(Date.now() + TENTATIVE_TTL_MS),
          updatedAt: new Date(),
        })
        .where(
          and(
            scoped(schema.rental.organizationId, organizationId, eq(schema.rental.id, current.id)),
            eq(schema.rental.status, "tentativa")
          )
        )
        .returning();
      const row = updated[0];
      if (!row) {
        // Entre el SELECT y el UPDATE alguien la confirmó/canceló: no pisarla.
        throw new RentalError("reserva_inexistente", "La tentativa ya no existe");
      }
      return row;
    });
    publish(organizationId, { type: "rental.updated", data: { rentalId: rental.id } });
    return rental;
  } catch (err) {
    if (!isExclusionViolation(err)) throw err;
    const recovery = await buildRaceRecovery(organizationId, conversationId, offer);
    const raceErr = new RentalError(
      "recien_tomada",
      "Otra reserva ganó esa unidad en ese rango"
    );
    raceErr.offers = recovery.offers;
    raceErr.alternatives = recovery.alternatives;
    throw raceErr;
  }
}

/** Días del período, expuesto para la capa de API y los tests. */
export { periodDays };

import { desc, eq, gt, isNull, lte, or } from "drizzle-orm";
import { getDb, schema } from "@/lib/db";
import { scoped } from "@/lib/db/tenant";

/**
 * 017 — Motor de cotización. UNA sola implementación: la usan el endpoint del
 * bot y el simulador de la UI de tarifas, así un precio que ve el dueño en el
 * simulador es EXACTAMENTE el que el agente le dice a un lead.
 *
 * Todo en centavos enteros de la moneda del negocio (ARS). El redondeo de los
 * escalones prorrateados es hacia el entero más cercano y ocurre UNA vez por
 * renglón: nada de flotantes acumulados.
 */

/** IVA argentino sobre servicios de alquiler de maquinaria con operario o sin él. */
export const IVA_PCT = 21;

/** Los campos del tarifario que la cotización necesita. */
export type RateForQuote = {
  dailyCents: number;
  weeklyCents: number | null;
  monthlyCents: number | null;
  transferBaseCents: number;
  transferPerKmCents: number;
  operatorDailyCents: number;
};

export type QuoteInput = {
  days: number;
  withTransfer: boolean;
  /** Distancia a obra en km (solo suma si `withTransfer`). */
  km?: number;
  /** Del modelo (`requiresOperator`): el operario no es opcional si la máquina lo exige. */
  requiresOperator: boolean;
};

export type QuoteBreakdown = {
  days: number;
  /** Qué escalón del tarifario se aplicó. */
  tier: "diaria" | "semanal" | "mensual";
  baseCents: number;
  transferCents: number;
  operatorCents: number;
  subtotalCents: number;
  ivaCents: number;
  totalCents: number;
  ivaPct: number;
};

/**
 * Tarifa escalonada: ≥30 días cotiza con la mensual prorrateada, ≥7 con la
 * semanal, si no diaria. Si el tarifario no define un escalón (NULL), se cae
 * al inmediato inferior — nunca se inventa un precio.
 */
export function computeQuote(rate: RateForQuote, input: QuoteInput): QuoteBreakdown {
  if (!Number.isInteger(input.days) || input.days < 1) {
    throw new Error(`computeQuote: días inválidos (${input.days})`);
  }
  const days = input.days;

  let tier: QuoteBreakdown["tier"] = "diaria";
  let baseCents = rate.dailyCents * days;
  if (days >= 30 && rate.monthlyCents != null) {
    tier = "mensual";
    baseCents = Math.round((rate.monthlyCents * days) / 30);
  } else if (days >= 7 && rate.weeklyCents != null) {
    tier = "semanal";
    baseCents = Math.round((rate.weeklyCents * days) / 7);
  }

  const km = input.withTransfer ? Math.max(0, Math.round(input.km ?? 0)) : 0;
  const transferCents = input.withTransfer
    ? rate.transferBaseCents + rate.transferPerKmCents * km
    : 0;

  const operatorCents = input.requiresOperator ? rate.operatorDailyCents * days : 0;

  const subtotalCents = baseCents + transferCents + operatorCents;
  const ivaCents = Math.round((subtotalCents * IVA_PCT) / 100);

  return {
    days,
    tier,
    baseCents,
    transferCents,
    operatorCents,
    subtotalCents,
    ivaCents,
    totalCents: subtotalCents + ivaCents,
    ivaPct: IVA_PCT,
  };
}

/**
 * La tarifa VIGENTE de un modelo a una fecha: la más reciente cuyo
 * `validFrom` ya pasó y cuyo `validTo` no llegó (NULL = sin fecha de fin).
 * Devuelve null si el modelo no tiene tarifa — cotizar sin tarifa es
 * inventar un precio, y eso está prohibido en todo el sistema.
 */
export async function getCurrentRate(
  organizationId: string,
  modelId: string,
  at: Date = new Date()
): Promise<(typeof schema.rateCard.$inferSelect) | null> {
  const db = getDb();
  const rows = await db
    .select()
    .from(schema.rateCard)
    .where(
      scoped(
        schema.rateCard.organizationId,
        organizationId,
        eq(schema.rateCard.modelId, modelId),
        lte(schema.rateCard.validFrom, at),
        or(isNull(schema.rateCard.validTo), gt(schema.rateCard.validTo, at))
      )
    )
    .orderBy(desc(schema.rateCard.validFrom))
    .limit(1);
  return rows[0] ?? null;
}

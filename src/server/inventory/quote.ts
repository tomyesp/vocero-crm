import { desc, eq, gt, isNull, lte, or } from "drizzle-orm";
import { getDb, schema } from "@/lib/db";
import { scoped } from "@/lib/db/tenant";

/**
 * 017 — Motor de cotización. UNA sola implementación: la usan el endpoint del
 * bot y el simulador de la UI de tarifas, así un precio que ve el dueño en el
 * simulador es EXACTAMENTE el que el agente le dice a un lead.
 *
 * RPM cotiza la HORA DE MÁQUINA. El precio de una obra es, entonces,
 * `días × horas por día × tarifa horaria`, y la hora ya trae adentro el
 * operario y el combustible: no hay renglón para ninguno de los dos. Lo único
 * que se suma aparte es el traslado.
 *
 * Los montos que salen de acá son NETOS: el catálogo del negocio está sin IVA
 * y el agente lo aclara al decir el precio. El motor no calcula IVA a
 * propósito — si devolviera un total con IVA junto a uno sin, tarde o
 * temprano el agente diría el que no corresponde.
 *
 * Todo en centavos enteros de la moneda del negocio (ARS).
 */

/**
 * Lo que dura una jornada completa cuando el lead dice "todo el día" y nadie
 * habló de horas. No es un default silencioso del motor: quien cotiza pasa
 * las horas SIEMPRE, y este número existe para que la pregunta del agente y
 * el placeholder de la UI digan lo mismo.
 */
export const FULL_DAY_HOURS = 8;

/** Los campos del tarifario que la cotización necesita. */
export type RateForQuote = {
  hourlyCents: number;
  /** Mínimo facturable del SERVICIO (no por día); 0 = sin mínimo. */
  minHours: number;
  transferBaseCents: number;
  transferPerKmCents: number;
};

export type QuoteInput = {
  days: number;
  /** Horas de trabajo por día pactadas con el lead. */
  hoursPerDay: number;
  withTransfer: boolean;
  /** Distancia a obra en km (solo suma si `withTransfer`). */
  km?: number;
};

export type QuoteBreakdown = {
  days: number;
  hoursPerDay: number;
  /** Lo que pidió el lead: `days × hoursPerDay`. */
  requestedHours: number;
  /** Lo que se factura: las pedidas, o el mínimo del tarifario si es mayor. */
  billedHours: number;
  minHours: number;
  hourlyCents: number;
  /** Horas facturadas × tarifa. Incluye operario y combustible. */
  machineCents: number;
  transferCents: number;
  totalCents: number;
  /**
   * Literal `false` y no un booleano: obliga a que todo consumidor —API, UI y
   * el texto que arma el agente— diga que el precio es sin IVA.
   */
  includesVat: false;
};

/**
 * El precio de una obra. Sin escalones: una obra larga son más horas, no otra
 * tarifa. El mínimo se aplica UNA vez sobre el total de horas del servicio,
 * que es como se cobra un mínimo en el rubro — un trabajo de 2 horas con
 * mínimo de 4 se cobra 4, no una obra de 3 días de 2 horas se cobra 12.
 */
export function computeQuote(rate: RateForQuote, input: QuoteInput): QuoteBreakdown {
  if (!Number.isInteger(input.days) || input.days < 1) {
    throw new Error(`computeQuote: días inválidos (${input.days})`);
  }
  if (!Number.isFinite(input.hoursPerDay) || input.hoursPerDay <= 0 || input.hoursPerDay > 24) {
    throw new Error(`computeQuote: horas por día inválidas (${input.hoursPerDay})`);
  }
  const days = input.days;
  const hoursPerDay = input.hoursPerDay;

  const requestedHours = days * hoursPerDay;
  const minHours = Math.max(0, rate.minHours);
  const billedHours = Math.max(requestedHours, minHours);
  // Redondeo UNA vez, acá: las horas pueden ser fraccionarias (media jornada
  // de 4,5 h es normal) y los centavos no.
  const machineCents = Math.round(rate.hourlyCents * billedHours);

  const km = input.withTransfer ? Math.max(0, Math.round(input.km ?? 0)) : 0;
  const transferCents = input.withTransfer
    ? rate.transferBaseCents + rate.transferPerKmCents * km
    : 0;

  return {
    days,
    hoursPerDay,
    requestedHours,
    billedHours,
    minHours,
    hourlyCents: rate.hourlyCents,
    machineCents,
    transferCents,
    totalCents: machineCents + transferCents,
    includesVat: false,
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

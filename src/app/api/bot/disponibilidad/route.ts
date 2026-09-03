import { eq } from "drizzle-orm";
import { getDb, schema } from "@/lib/db";
import { apiError } from "@/lib/api";
import { scoped } from "@/lib/db/tenant";
import { requireBotKey, resolveInstanceOrg } from "@/server/bot/auth";
import { inventoryDisabledResponse, inventoryEnabled } from "@/server/inventory/flag";
import {
  findAlternatives,
  findAvailableUnits,
  nextFreeDate,
  type Period,
} from "@/server/inventory/availability";
import { replaceRentalOffers, type OfferDraft } from "@/server/inventory/offers";
import { computeQuote, getCurrentRate } from "@/server/inventory/quote";

export const dynamic = "force-dynamic";

/**
 * 017 — Disponibilidad para el cerebro externo. Igual que la agenda, esta
 * vista REGISTRA la oferta: solo un `ofertaId` emitido acá es reservable
 * después, y solo en esta conversación. El precio de la oferta sale de
 * `computeQuote` (sin traslado: eso se cotiza aparte) — el LLM no calcula.
 *
 * El punto comercial: la respuesta NUNCA es un "no hay" seco. Sin unidades
 * del modelo, van la próxima fecha libre y alternativas de la categoría,
 * cada una con su propia oferta reservable.
 */

const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_DAYS = 365;

function parseDay(raw: string | null): Date | null {
  if (!raw) return null;
  const iso = /^\d{4}-\d{2}-\d{2}$/.test(raw) ? `${raw}T00:00:00.000Z` : raw;
  const t = Date.parse(iso);
  return Number.isNaN(t) ? null : new Date(t);
}

function fmtDay(d: Date): string {
  return d.toLocaleDateString("es-AR", { day: "numeric", month: "short", timeZone: "UTC" });
}

function isoDay(d: Date): string {
  return d.toISOString().slice(0, 10);
}

type ModelRow = typeof schema.machineModel.$inferSelect;

async function loadModel(organizationId: string, modelId: string): Promise<ModelRow | null> {
  const db = getDb();
  const rows = await db
    .select()
    .from(schema.machineModel)
    .where(scoped(schema.machineModel.organizationId, organizationId, eq(schema.machineModel.id, modelId)))
    .limit(1);
  return rows[0] ?? null;
}

/** Draft de oferta para un modelo en un período, con el precio del motor. */
async function draftFor(
  organizationId: string,
  model: ModelRow,
  unitId: string,
  period: Period,
  days: number
): Promise<OfferDraft | null> {
  const rate = await getCurrentRate(organizationId, model.id);
  if (!rate) return null; // sin tarifa no se ofrece: ofertar sin precio es inventar
  const quote = computeQuote(rate, {
    days,
    withTransfer: false,
    requiresOperator: model.requiresOperator,
  });
  return {
    modelId: model.id,
    unitId,
    period,
    quotedAmountCents: quote.totalCents,
    label: `${model.name}, ${fmtDay(period.from)} al ${fmtDay(period.to)}`,
  };
}

export async function GET(req: Request) {
  if (!inventoryEnabled()) return inventoryDisabledResponse();

  const denied = requireBotKey(req);
  if (denied) return denied;

  const organizationId = await resolveInstanceOrg();
  if (!organizationId) {
    return apiError(409, "no_org", "La instancia aún no tiene organización");
  }

  const url = new URL(req.url);
  const modelId = url.searchParams.get("modeloId");
  const desde = parseDay(url.searchParams.get("desde"));
  const hasta = parseDay(url.searchParams.get("hasta"));
  const conversationId = url.searchParams.get("conversationId");
  // Sin parámetros responde 422: es el probe de capacidad de Nea (404 = el
  // motor no existe; 422 = existe y quiere parámetros).
  if (!modelId || !desde || !hasta || !conversationId) {
    return apiError(422, "invalid_body", "Faltan modeloId, desde, hasta o conversationId");
  }
  const days = Math.round((hasta.getTime() - desde.getTime()) / DAY_MS);
  if (days < 1 || days > MAX_DAYS) {
    return apiError(422, "rango_invalido", "El rango debe ser de 1 a 365 días");
  }

  const db = getDb();
  const convs = await db
    .select({ id: schema.conversation.id })
    .from(schema.conversation)
    .where(scoped(schema.conversation.organizationId, organizationId, eq(schema.conversation.id, conversationId)))
    .limit(1);
  if (!convs[0]) return apiError(404, "not_found", "Conversación no encontrada");

  const model = await loadModel(organizationId, modelId);
  if (!model || !model.active) return apiError(404, "not_found", "Modelo desconocido");

  const period: Period = { from: desde, to: hasta };
  const free = await findAvailableUnits(organizationId, modelId, period);

  const drafts: OfferDraft[] = [];
  if (free.length > 0) {
    // Una sola unidad (la de menos horas): el lead elige modelo, no chapa.
    const draft = await draftFor(organizationId, model, free[0]!.id, period, days);
    if (!draft) return apiError(409, "sin_tarifa", "El modelo no tiene tarifa vigente");
    drafts.push(draft);
  }

  // Alternativas de la categoría (haya o no disponibilidad del pedido: si el
  // modelo pedido está libre, no hacen falta; si no, son la salida).
  const alternativeDrafts: OfferDraft[] = [];
  if (free.length === 0) {
    const alts = await findAlternatives(organizationId, model.categoryId, modelId, period);
    for (const alt of alts.slice(0, 3)) {
      const altModel = await loadModel(organizationId, alt.modelId);
      if (!altModel) continue;
      const draft = await draftFor(organizationId, altModel, alt.unitId, period, days);
      if (draft) alternativeDrafts.push(draft);
    }
  }

  // Reemplazo completo de la oferta de la conversación (la vigente es la última).
  const issued = await replaceRentalOffers(organizationId, conversationId, [
    ...drafts,
    ...alternativeDrafts,
  ]);
  const serialize = (o: (typeof issued)[number]) => ({
    ofertaId: o.offerId,
    modeloId: o.modelId,
    desde: isoDay(o.period.from),
    hasta: isoDay(o.period.to),
    dias: days,
    montoCotizadoCents: o.quotedAmountCents,
    etiqueta: o.label,
    expiraEn: o.expiresAt.toISOString(),
  });

  if (drafts.length > 0) {
    return Response.json({
      disponible: true,
      ofertas: issued.slice(0, drafts.length).map(serialize),
      nota: "El monto no incluye traslado; cotizalo con la tool de cotización si el lead lo pide.",
    });
  }

  const proxima = await nextFreeDate(organizationId, modelId, desde, days);
  return Response.json({
    disponible: false,
    // `sin_unidades` = ni siquiera hay fecha futura (flota en baja/mantenimiento).
    motivo: proxima ? "ocupado" : "sin_unidades",
    proximaFechaLibre: proxima ? isoDay(proxima) : null,
    alternativas: issued.map(serialize),
  });
}

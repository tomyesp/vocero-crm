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
  TRANSFER_BUFFER_DAYS,
  type Period,
} from "@/server/inventory/availability";
import { replaceRentalOffers, type OfferDraft } from "@/server/inventory/offers";
import { computeQuote, FULL_DAY_HOURS, getCurrentRate } from "@/server/inventory/quote";

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
 *
 * `horasPorDia` es OPCIONAL acá y obligatoria en /cotizar, y la asimetría es
 * a propósito: esta vista contesta "¿está libre?", una pregunta que no
 * depende de las horas, y sería absurdo exigir que el agente negocie la
 * jornada antes de poder mirar el calendario. Cuando falta se cotiza la
 * jornada completa y la respuesta lo DICE —en la etiqueta y en la nota—, así
 * el número nunca es una suposición callada.
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

/** 8, no "8.0"; 4,5 con coma, que es como se escribe media jornada acá. */
function fmtHours(h: number): string {
  return Number.isInteger(h) ? String(h) : h.toFixed(1).replace(".", ",");
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
  days: number,
  hoursPerDay: number
): Promise<OfferDraft | null> {
  const rate = await getCurrentRate(organizationId, model.id);
  if (!rate) return null; // sin tarifa no se ofrece: ofertar sin precio es inventar
  const quote = computeQuote(rate, { days, hoursPerDay, withTransfer: false });
  return {
    modelId: model.id,
    unitId,
    period,
    hoursPerDay,
    quotedAmountCents: quote.totalCents,
    // Las horas van en la etiqueta que ve el lead: un precio de alquiler por
    // hora sin las horas al lado no se puede ni verificar ni discutir.
    label: `${model.name}, ${fmtDay(period.from)} al ${fmtDay(period.to)}, ${fmtHours(hoursPerDay)} hs/día`,
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
  const horasRaw = url.searchParams.get("horasPorDia");
  // Sin parámetros responde 422: es el probe de capacidad de Nea (404 = el
  // motor no existe; 422 = existe y quiere parámetros). Va ANTES que la
  // validación de horas para que el probe pegue siempre en el mismo lugar.
  if (!modelId || !desde || !hasta || !conversationId) {
    return apiError(422, "invalid_body", "Faltan modeloId, desde, hasta o conversationId");
  }
  const hoursPerDay = horasRaw === null ? FULL_DAY_HOURS : Number(horasRaw);
  if (!Number.isFinite(hoursPerDay) || hoursPerDay < 0.5 || hoursPerDay > 24) {
    return apiError(422, "horas_invalidas", "horasPorDia debe ser un número entre 0,5 y 24");
  }
  const days = Math.round((hasta.getTime() - desde.getTime()) / DAY_MS);
  if (days < 1 || days > MAX_DAYS) {
    return apiError(422, "rango_invalido", "El rango debe ser de 1 a 365 días");
  }

  const db = getDb();
  const convs = await db
    .select({ id: schema.conversation.id, isTest: schema.conversation.isTest })
    .from(schema.conversation)
    .where(scoped(schema.conversation.organizationId, organizationId, eq(schema.conversation.id, conversationId)))
    .limit(1);
  if (!convs[0]) return apiError(404, "not_found", "Conversación no encontrada");
  // Fase 7 — Contra qué calendario se responde. Una conversación del
  // Laboratorio ve solo reservas de prueba; una real, solo reales.
  const isTest = convs[0].isTest;

  const model = await loadModel(organizationId, modelId);
  if (!model || !model.active) return apiError(404, "not_found", "Modelo desconocido");

  const period: Period = { from: desde, to: hasta };
  // Fase 7 (bis) — La tentativa de ESTA conversación no le tapa la máquina a
  // su propio dueño: si lo hiciera, un lead que corre las fechas de su obra
  // recibiría "está ocupada" por su propia reserva y mover la tentativa sería
  // inalcanzable (para mover hace falta una oferta; para ofertar, disponibilidad).
  const free = await findAvailableUnits(
    organizationId,
    modelId,
    period,
    TRANSFER_BUFFER_DAYS,
    isTest,
    conversationId
  );

  const drafts: OfferDraft[] = [];
  if (free.length > 0) {
    // Una sola unidad (la de menos horas): el lead elige modelo, no chapa.
    const draft = await draftFor(organizationId, model, free[0]!.id, period, days, hoursPerDay);
    if (!draft) return apiError(409, "sin_tarifa", "El modelo no tiene tarifa vigente");
    drafts.push(draft);
  }

  // Alternativas de la categoría (haya o no disponibilidad del pedido: si el
  // modelo pedido está libre, no hacen falta; si no, son la salida).
  const alternativeDrafts: OfferDraft[] = [];
  if (free.length === 0) {
    const alts = await findAlternatives(
      organizationId,
      model.categoryId,
      modelId,
      period,
      TRANSFER_BUFFER_DAYS,
      isTest,
      conversationId
    );
    for (const alt of alts.slice(0, 3)) {
      const altModel = await loadModel(organizationId, alt.modelId);
      if (!altModel) continue;
      const draft = await draftFor(organizationId, altModel, alt.unitId, period, days, hoursPerDay);
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
    horasPorDia: o.hoursPerDay,
    montoCotizadoCents: o.quotedAmountCents,
    etiqueta: o.label,
    expiraEn: o.expiresAt.toISOString(),
  });

  if (drafts.length > 0) {
    return Response.json({
      disponible: true,
      ofertas: issued.slice(0, drafts.length).map(serialize),
      horasPorDia: hoursPerDay,
      nota:
        `El monto está calculado a ${fmtHours(hoursPerDay)} horas por día` +
        (horasRaw === null ? " (jornada completa, porque no pediste otras horas)" : "") +
        ". Es SIN IVA, ya incluye operario y combustible, y NO incluye traslado" +
        " (eso se cotiza aparte). Si el lead necesita otra cantidad de horas por" +
        " día, volvé a consultar disponibilidad con ese número: el precio cambia" +
        " y esta oferta ya no sirve.",
    });
  }

  const proxima = await nextFreeDate(
    organizationId,
    modelId,
    desde,
    days,
    TRANSFER_BUFFER_DAYS,
    90,
    isTest,
    conversationId
  );
  return Response.json({
    disponible: false,
    // `sin_unidades` = ni siquiera hay fecha futura (flota en baja/mantenimiento).
    motivo: proxima ? "ocupado" : "sin_unidades",
    proximaFechaLibre: proxima ? isoDay(proxima) : null,
    alternativas: issued.map(serialize),
  });
}

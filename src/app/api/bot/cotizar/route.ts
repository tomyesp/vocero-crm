import { eq } from "drizzle-orm";
import { z } from "zod";
import { getDb, schema } from "@/lib/db";
import { apiError, parseBody } from "@/lib/api";
import { scoped } from "@/lib/db/tenant";
import { requireBotKey, resolveInstanceOrg } from "@/server/bot/auth";
import { inventoryDisabledResponse, inventoryEnabled } from "@/server/inventory/flag";
import { computeQuote, getCurrentRate } from "@/server/inventory/quote";

export const dynamic = "force-dynamic";

const postSchema = z.object({
  modeloId: z.string().trim().min(1),
  dias: z.number().int().min(1).max(365),
  // OBLIGATORIA: RPM cotiza la hora, así que sin horas no hay precio. Que sea
  // requerida es el guardarraíl — obliga a que alguien se lo haya preguntado
  // al lead en vez de que el servidor suponga una jornada.
  horasPorDia: z.number().min(0.5).max(24),
  // `.optional()` y no `.default()`: con un default, Zod 3 hace que el tipo de
  // entrada difiera del de salida y `parseBody` exige que coincidan.
  conTraslado: z.boolean().optional(),
  km: z.number().min(0).max(2000).optional(),
});

/**
 * 017 — Cotización para el cerebro externo: el MISMO motor que el simulador
 * de la UI. El agente jamás calcula, redondea ni estima un precio — este
 * desglose es lo único que puede comunicar.
 */
export async function POST(req: Request) {
  if (!inventoryEnabled()) return inventoryDisabledResponse();

  const denied = requireBotKey(req);
  if (denied) return denied;

  const organizationId = await resolveInstanceOrg();
  if (!organizationId) {
    return apiError(409, "no_org", "La instancia aún no tiene organización");
  }

  const body = await parseBody(req, postSchema);
  if (!body.ok) return body.response;

  const db = getDb();
  const models = await db
    .select({
      name: schema.machineModel.name,
      requiresOperator: schema.machineModel.requiresOperator,
      active: schema.machineModel.active,
    })
    .from(schema.machineModel)
    .where(scoped(schema.machineModel.organizationId, organizationId, eq(schema.machineModel.id, body.data.modeloId)))
    .limit(1);
  const model = models[0];
  if (!model || !model.active) return apiError(404, "not_found", "Modelo desconocido");

  const rate = await getCurrentRate(organizationId, body.data.modeloId);
  if (!rate) return apiError(409, "sin_tarifa", "El modelo no tiene tarifa vigente");

  const q = computeQuote(rate, {
    days: body.data.dias,
    hoursPerDay: body.data.horasPorDia,
    withTransfer: body.data.conTraslado ?? false,
    km: body.data.km,
  });

  return Response.json({
    modelo: model.name,
    dias: q.days,
    horasPorDia: q.hoursPerDay,
    horasFacturadas: q.billedHours,
    // Distinto de `horasFacturadas` solo cuando el mínimo del tarifario pisó
    // lo pedido: es lo que el agente tiene que poder explicar sin inventar.
    horasPedidas: q.requestedHours,
    minimoHoras: q.minHours,
    tarifaHoraCents: q.hourlyCents,
    desglose: {
      maquinaCents: q.machineCents,
      trasladoCents: q.transferCents,
      totalCents: q.totalCents,
    },
    incluyeOperario: true,
    incluyeCombustible: true,
    incluyeIva: false,
    requiereOperario: model.requiresOperator,
  });
}

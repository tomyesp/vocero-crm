import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { getDb, schema } from "@/lib/db";
import { apiError, parseBody } from "@/lib/api";
import { requireBotKey, resolveInstanceOrg } from "@/server/bot/auth";
import { inventoryDisabledResponse, inventoryEnabled } from "@/server/inventory/flag";
import { rentalErrorResponse } from "@/server/inventory/http";
import {
  createTentativeRental,
  moveTentativeRental,
  RentalError,
} from "@/server/inventory/reservations";

export const dynamic = "force-dynamic";

/**
 * 017 — Reserva TENTATIVA del cerebro externo. El protocolo completo:
 *
 * 1. Solo un `ofertaId` emitido por /api/bot/disponibilidad EN ESTA
 *    conversación es reservable (oferta_desconocida / oferta_vencida si no).
 * 2. La reserva nace `tentativa` con TTL: confirmar es SOLO humano, en la UI.
 * 3. La carrera la corta la base: `recien_tomada` llega con ofertas frescas
 *    y/o alternativas en el body, para re-ofrecer en el mismo turno.
 * 4. Gate de handoff (igual que /api/bot/messages): si un humano tomó la
 *    conversación entre el contexto y la reserva, el agente no reserva.
 */

const postSchema = z.object({
  conversationId: z.string().trim().min(1),
  ofertaId: z.string().trim().min(1),
  localidadObra: z.string().trim().max(200).optional(),
  conTraslado: z.boolean().optional(),
  notas: z.string().trim().max(500).optional(),
});

const patchSchema = z.object({
  conversationId: z.string().trim().min(1),
  ofertaId: z.string().trim().min(1),
});

async function handoffGate(
  organizationId: string,
  conversationId: string
): Promise<Response | null> {
  const db = getDb();
  const convs = await db
    .select({
      aiEnabled: schema.conversation.aiEnabled,
      handoffAt: schema.conversation.handoffAt,
    })
    .from(schema.conversation)
    .where(
      and(
        eq(schema.conversation.organizationId, organizationId),
        eq(schema.conversation.id, conversationId)
      )
    )
    .limit(1);
  const conv = convs[0];
  if (!conv) return apiError(404, "not_found", "Conversación no encontrada");
  if (!conv.aiEnabled || conv.handoffAt) {
    return apiError(409, "ai_paused", "La IA está en pausa en esta conversación");
  }
  return null;
}

function serializeRental(r: typeof schema.rental.$inferSelect) {
  return {
    reservaId: r.id,
    estado: r.status,
    unidadId: r.unitId,
    desde: r.period.from.toISOString().slice(0, 10),
    hasta: r.period.to.toISOString().slice(0, 10),
    // El monto sin las horas es un número que el agente no puede explicar si
    // el lead lo repregunta. Viajan juntos.
    horasPorDia: r.hoursPerDay,
    montoCotizadoCents: r.quotedAmountCents,
    expiraEn: r.expiresAt?.toISOString() ?? null,
  };
}

export async function POST(req: Request) {
  if (!inventoryEnabled()) return inventoryDisabledResponse();
  const denied = requireBotKey(req);
  if (denied) return denied;
  const organizationId = await resolveInstanceOrg();
  if (!organizationId) return apiError(409, "no_org", "La instancia aún no tiene organización");

  const body = await parseBody(req, postSchema);
  if (!body.ok) return body.response;

  const gate = await handoffGate(organizationId, body.data.conversationId);
  if (gate) return gate;

  try {
    const rental = await createTentativeRental({
      organizationId,
      conversationId: body.data.conversationId,
      offerId: body.data.ofertaId,
      createdBy: "agente",
      siteLocation: body.data.localidadObra,
      withTransfer: body.data.conTraslado,
      notes: body.data.notas,
    });
    return Response.json({ reserva: serializeRental(rental) }, { status: 201 });
  } catch (err) {
    if (err instanceof RentalError) return rentalErrorResponse(err);
    throw err;
  }
}

export async function PATCH(req: Request) {
  if (!inventoryEnabled()) return inventoryDisabledResponse();
  const denied = requireBotKey(req);
  if (denied) return denied;
  const organizationId = await resolveInstanceOrg();
  if (!organizationId) return apiError(409, "no_org", "La instancia aún no tiene organización");

  const body = await parseBody(req, patchSchema);
  if (!body.ok) return body.response;

  const gate = await handoffGate(organizationId, body.data.conversationId);
  if (gate) return gate;

  try {
    const rental = await moveTentativeRental({
      organizationId,
      conversationId: body.data.conversationId,
      offerId: body.data.ofertaId,
    });
    return Response.json({ reserva: serializeRental(rental) });
  } catch (err) {
    if (err instanceof RentalError) return rentalErrorResponse(err);
    throw err;
  }
}

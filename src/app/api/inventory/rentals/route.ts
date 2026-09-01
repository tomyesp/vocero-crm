import { z } from "zod";
import { apiError, parseBody, withAuth } from "@/lib/api";
import { getDb, schema } from "@/lib/db";
import { newId } from "@/lib/db/ids";
import { publish } from "@/server/events/bus";
import { inventoryDisabledResponse, inventoryEnabled } from "@/server/inventory/flag";
import { listRentals, type RentalListItem } from "@/server/inventory/queries";

export const dynamic = "force-dynamic";

const STATUSES = ["tentativa", "confirmada", "en_curso", "finalizada", "cancelada"] as const;

export const GET = withAuth(async (session, req: Request) => {
  if (!inventoryEnabled()) return inventoryDisabledResponse();
  const params = new URL(req.url).searchParams;
  const status = params
    .getAll("status")
    .filter((s): s is RentalListItem["status"] => (STATUSES as readonly string[]).includes(s));
  const rentals = await listRentals(session.organizationId, {
    status: status.length > 0 ? status : undefined,
    unitId: params.get("unitId") ?? undefined,
    contactId: params.get("contactId") ?? undefined,
  });
  return Response.json({ rentals });
});

const postSchema = z.object({
  unitId: z.string().trim().min(1),
  kind: z.enum(["alquiler", "mantenimiento"]).default("alquiler"),
  from: z.string().datetime(),
  to: z.string().datetime(),
  contactId: z.string().trim().min(1).optional(),
  quotedAmountCents: z.number().int().min(0).nullable().optional(),
  withTransfer: z.boolean().optional(),
  siteLocation: z.string().trim().max(200).optional(),
  notes: z.string().trim().max(1000).optional(),
});

/**
 * 017 — Alta MANUAL desde la UI (un humano): alquiler directo o bloqueo de
 * mantenimiento. Nace `confirmada` (la tentativa es cosa del agente). El
 * solape lo corta la base: 23P01 ⇒ 409.
 */
export const POST = withAuth(async (session, req: Request) => {
  if (!inventoryEnabled()) return inventoryDisabledResponse();
  const body = await parseBody(req, postSchema);
  if (!body.ok) return body.response;

  const from = new Date(body.data.from);
  const to = new Date(body.data.to);
  if (to.getTime() <= from.getTime()) {
    return apiError(422, "rango_invalido", "La fecha de fin debe ser posterior a la de inicio");
  }

  const db = getDb();
  try {
    const inserted = await db
      .insert(schema.rental)
      .values({
        id: newId("rental"),
        organizationId: session.organizationId,
        unitId: body.data.unitId,
        kind: body.data.kind,
        contactId: body.data.contactId ?? null,
        period: { from, to },
        status: "confirmada",
        createdBy: "humano",
        quotedAmountCents: body.data.quotedAmountCents ?? null,
        withTransfer: body.data.withTransfer ?? false,
        siteLocation: body.data.siteLocation ?? null,
        notes: body.data.notes ?? null,
      })
      .returning();
    const rental = inserted[0]!;
    publish(session.organizationId, { type: "rental.updated", data: { rentalId: rental.id } });
    return Response.json({ rental }, { status: 201 });
  } catch (err) {
    const code = (err as { code?: string })?.code ?? (err as { cause?: { code?: string } })?.cause?.code;
    if (code === "23P01") {
      return apiError(409, "solapada", "La unidad ya tiene una reserva activa en ese rango");
    }
    throw err;
  }
});

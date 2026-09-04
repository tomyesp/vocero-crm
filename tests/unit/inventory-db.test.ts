import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * 017 — Integración contra Postgres REAL: solapes, buffer de traslado,
 * consumo de ofertas y la carrera de dos reservas concurrentes sobre la
 * misma unidad (la segunda DEBE perder a nivel base de datos, no de código).
 *
 * Corre solo si hay un Postgres accesible vía el DATABASE_URL del `.env`
 * local (el de `docker-compose.dev.yml`); sin base, la suite se salta —
 * mismo espíritu que el arnés E2E, que también exige la app viva.
 *
 * Crea SU propia organización y la borra al final: el cascade limpia todo.
 */

function loadDotEnv(): void {
  try {
    const env = readFileSync(".env", "utf8");
    for (const line of env.split(/\r?\n/)) {
      const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
      if (m && m[1] && process.env[m[1]] === undefined) {
        process.env[m[1]] = m[2];
      }
    }
  } catch {
    // sin .env: la suite decidirá saltarse por falta de conexión
  }
}

loadDotEnv();

async function canConnect(): Promise<boolean> {
  if (!process.env.DATABASE_URL) return false;
  try {
    const { getSql } = await import("@/lib/db");
    await getSql()`select 1`;
    return true;
  } catch {
    return false;
  }
}

const dbAvailable = await canConnect();

const DAY_MS = 24 * 60 * 60 * 1000;
/** Días relativos, ancla fija para que los rangos del test no dependan del reloj. */
const T0 = Date.parse("2027-03-01T00:00:00.000Z");
const day = (n: number) => new Date(T0 + n * DAY_MS);

describe.runIf(dbAvailable)("inventario contra Postgres real", () => {
  let orgId: string;
  let modelId: string;
  let unitA: string;
  let unitB: string;
  let convId: string;
  let contactId: string;

  beforeAll(async () => {
    const { getDb, schema } = await import("@/lib/db");
    const { newId } = await import("@/lib/db/ids");
    const db = getDb();

    orgId = newId("organization");
    await db.insert(schema.organization).values({
      id: orgId,
      name: "Test Inventario",
      slug: `test-inventario-${orgId.slice(-8)}`,
      createdAt: new Date(),
    });

    const catId = newId("machineCategory");
    await db.insert(schema.machineCategory).values({
      id: catId,
      organizationId: orgId,
      name: "Retros de prueba",
      slug: "retros-test",
    });

    modelId = newId("machineModel");
    await db.insert(schema.machineModel).values({
      id: modelId,
      organizationId: orgId,
      categoryId: catId,
      name: "Retro de prueba",
    });

    unitA = newId("machineUnit");
    unitB = newId("machineUnit");
    await db.insert(schema.machineUnit).values([
      // A con MÁS horas que B: la rotación debe preferir B.
      { id: unitA, organizationId: orgId, modelId, internalCode: "T-A", usageHours: 5000 },
      { id: unitB, organizationId: orgId, modelId, internalCode: "T-B", usageHours: 100 },
    ]);

    contactId = newId("contact");
    await db.insert(schema.contact).values({
      id: contactId,
      organizationId: orgId,
      name: "Lead Test",
      waIdentity: `test-${orgId.slice(-8)}`,
    });
    convId = newId("conversation");
    await db.insert(schema.conversation).values({
      id: convId,
      organizationId: orgId,
      contactId,
      channel: "whatsapp",
    });
  });

  afterAll(async () => {
    if (!orgId) return;
    const { getDb, schema } = await import("@/lib/db");
    const { eq } = await import("drizzle-orm");
    // machine_model/unit usan RESTRICT: se limpian a mano antes del cascade.
    const db = getDb();
    await db.delete(schema.rentalOffer).where(eq(schema.rentalOffer.organizationId, orgId));
    await db.delete(schema.rental).where(eq(schema.rental.organizationId, orgId));
    await db.delete(schema.machineUnit).where(eq(schema.machineUnit.organizationId, orgId));
    await db.delete(schema.machineModel).where(eq(schema.machineModel.organizationId, orgId));
    await db.delete(schema.organization).where(eq(schema.organization.id, orgId));
  });

  it("una reserva activa tapa la unidad; una cancelada no", async () => {
    const { getDb, schema } = await import("@/lib/db");
    const { newId } = await import("@/lib/db/ids");
    const { findAvailableUnits } = await import("@/server/inventory/availability");
    const db = getDb();

    // A ocupada del día 10 al 20; B con reserva CANCELADA en el mismo rango.
    await db.insert(schema.rental).values([
      {
        id: newId("rental"),
        organizationId: orgId,
        unitId: unitA,
        period: { from: day(10), to: day(20) },
        status: "confirmada",
      },
      {
        id: newId("rental"),
        organizationId: orgId,
        unitId: unitB,
        period: { from: day(10), to: day(20) },
        status: "cancelada",
      },
    ]);

    const free = await findAvailableUnits(orgId, modelId, { from: day(12), to: day(15) }, 0);
    expect(free.map((u) => u.id)).toEqual([unitB]);
  });

  it("el buffer de traslado tapa el día pegado a la devolución", async () => {
    const { findAvailableUnits } = await import("@/server/inventory/availability");

    // A devuelve el día 20. Pedir [20,25) con buffer 1 la alcanza (la máquina
    // vuelve de obra); pedir [21,26) ya no.
    const pegado = await findAvailableUnits(orgId, modelId, { from: day(20), to: day(25) }, 1);
    expect(pegado.map((u) => u.id)).not.toContain(unitA);

    const conAire = await findAvailableUnits(orgId, modelId, { from: day(21), to: day(26) }, 1);
    expect(conAire.map((u) => u.id)).toContain(unitA);
  });

  it("la rotación elige la unidad con menos horas", async () => {
    const { findAvailableUnits } = await import("@/server/inventory/availability");
    const free = await findAvailableUnits(orgId, modelId, { from: day(40), to: day(45) }, 1);
    expect(free.map((u) => u.id)).toEqual([unitB, unitA]);
  });

  it("una oferta vencida se rechaza como oferta_vencida; una ajena como oferta_desconocida", async () => {
    const { getDb, schema } = await import("@/lib/db");
    const { newId } = await import("@/lib/db/ids");
    const { validateOffer } = await import("@/server/inventory/offers");
    const db = getDb();

    const expiredId = newId("rentalOffer");
    await db.insert(schema.rentalOffer).values({
      id: expiredId,
      organizationId: orgId,
      conversationId: convId,
      modelId,
      unitId: unitB,
      period: { from: day(40), to: day(45) },
      quotedAmountCents: 100,
      label: "vencida",
      expiresAt: new Date(Date.now() - 1000),
    });
    const vencida = await validateOffer(orgId, convId, expiredId);
    expect(vencida).toMatchObject({ ok: false, reason: "oferta_vencida" });

    const ajena = await validateOffer(orgId, convId, "roff_inexistente123");
    expect(ajena).toMatchObject({ ok: false, reason: "oferta_desconocida" });
  });

  it("la tentativa nace de una oferta válida, la consume y expira sola", async () => {
    const { replaceRentalOffers } = await import("@/server/inventory/offers");
    const { createTentativeRental } = await import("@/server/inventory/reservations");
    const { validateOffer } = await import("@/server/inventory/offers");

    const [offer] = await replaceRentalOffers(orgId, convId, [
      {
        modelId,
        unitId: unitB,
        period: { from: day(50), to: day(55) },
        quotedAmountCents: 999_00,
        label: "Retro de prueba, día 50 al 55",
      },
    ]);

    const rental = await createTentativeRental({
      organizationId: orgId,
      conversationId: convId,
      offerId: offer!.offerId,
      createdBy: "agente",
    });
    expect(rental.status).toBe("tentativa");
    expect(rental.unitId).toBe(unitB);
    expect(rental.quotedAmountCents).toBe(999_00);
    expect(rental.expiresAt).not.toBeNull();
    expect(rental.contactId).toBe(contactId);

    // Consumo único: la misma oferta ya no vale.
    const otraVez = await validateOffer(orgId, convId, offer!.offerId);
    expect(otraVez.ok).toBe(false);
  });

  it("el job de expiración cancela la tentativa vencida y libera la unidad", async () => {
    const { getDb, schema } = await import("@/lib/db");
    const { newId } = await import("@/lib/db/ids");
    const { eq } = await import("drizzle-orm");
    const { expireTentativesOnce } = await import("@/server/inventory/expiration");
    const { findAvailableUnits } = await import("@/server/inventory/availability");
    const db = getDb();

    const period = { from: day(70), to: day(75) };
    const rentalId = newId("rental");
    await db.insert(schema.rental).values({
      id: rentalId,
      organizationId: orgId,
      unitId: unitB,
      period,
      status: "tentativa",
      createdBy: "agente",
      expiresAt: new Date(Date.now() - 60_000), // venció hace un minuto
    });

    // Mientras la tentativa vive, la unidad está tomada.
    const ocupada = await findAvailableUnits(orgId, modelId, period, 0);
    expect(ocupada.map((u) => u.id)).not.toContain(unitB);

    const cancelled = await expireTentativesOnce();
    expect(cancelled).toBeGreaterThanOrEqual(1);

    const rows = await db
      .select({ status: schema.rental.status })
      .from(schema.rental)
      .where(eq(schema.rental.id, rentalId));
    expect(rows[0]?.status).toBe("cancelada");

    // Y la flota vuelve a estar libre sin que nadie toque nada.
    const libre = await findAvailableUnits(orgId, modelId, period, 0);
    expect(libre.map((u) => u.id)).toContain(unitB);
  });

  it("una tentativa VIGENTE no la toca el job", async () => {
    const { getDb, schema } = await import("@/lib/db");
    const { newId } = await import("@/lib/db/ids");
    const { eq } = await import("drizzle-orm");
    const { expireTentativesOnce } = await import("@/server/inventory/expiration");
    const db = getDb();

    const rentalId = newId("rental");
    await db.insert(schema.rental).values({
      id: rentalId,
      organizationId: orgId,
      unitId: unitB,
      period: { from: day(80), to: day(85) },
      status: "tentativa",
      createdBy: "agente",
      expiresAt: new Date(Date.now() + 60 * 60_000),
    });

    await expireTentativesOnce();

    const rows = await db
      .select({ status: schema.rental.status })
      .from(schema.rental)
      .where(eq(schema.rental.id, rentalId));
    expect(rows[0]?.status).toBe("tentativa");
  });

  it("dos reservas CONCURRENTES sobre la misma unidad: la base deja pasar UNA", async () => {
    const { getDb, schema } = await import("@/lib/db");
    const { newId } = await import("@/lib/db/ids");
    const { and, eq, sql } = await import("drizzle-orm");
    const { createTentativeRental, RentalError } = await import(
      "@/server/inventory/reservations"
    );
    const db = getDb();

    // DOS leads distintos, cada uno con su conversación, peleando la misma
    // unidad en el mismo rango. Antes esta carrera se montaba sobre una sola
    // conversación —daba igual, nada miraba de quién era la reserva—, pero
    // desde 017 Fase 7 (bis) una conversación sostiene UNA tentativa: dos
    // reservas en el mismo hilo ya no son una carrera sino un doble bloqueo,
    // que es justo lo que ahora se rechaza. El escenario real que protege el
    // EXCLUDE siempre fue este: dos personas escribiendo al mismo tiempo.
    const otherContactId = newId("contact");
    const otherConvId = newId("conversation");
    await db.insert(schema.contact).values({
      id: otherContactId,
      organizationId: orgId,
      name: "Lead rival",
      waIdentity: `rival-${orgId.slice(-8)}`,
    });
    await db.insert(schema.conversation).values({
      id: otherConvId,
      organizationId: orgId,
      contactId: otherContactId,
      channel: "whatsapp",
    });

    const period = { from: day(60), to: day(65) };
    const convIds = [convId, otherConvId];
    const offerRows = [newId("rentalOffer"), newId("rentalOffer")].map((id, i) => ({
      id,
      organizationId: orgId,
      conversationId: convIds[i]!,
      modelId,
      unitId: unitA,
      period,
      quotedAmountCents: 500_00 + i,
      label: `carrera ${i}`,
      expiresAt: new Date(Date.now() + 60_000),
    }));
    await db.insert(schema.rentalOffer).values(offerRows);

    // El hilo principal pudo quedar con una tentativa de un test anterior:
    // se limpia para que la carrera arranque pareja.
    await db
      .delete(schema.rental)
      .where(
        and(
          eq(schema.rental.conversationId, convId),
          eq(schema.rental.status, "tentativa")
        )
      );

    const results = await Promise.allSettled(
      offerRows.map((o, i) =>
        createTentativeRental({
          organizationId: orgId,
          conversationId: convIds[i]!,
          offerId: o.id,
          createdBy: "agente",
        })
      )
    );

    const ok = results.filter((r) => r.status === "fulfilled");
    const failed = results.filter(
      (r): r is PromiseRejectedResult => r.status === "rejected"
    );
    expect(ok).toHaveLength(1);
    expect(failed).toHaveLength(1);
    expect(failed[0]!.reason).toBeInstanceOf(RentalError);
    expect((failed[0]!.reason as InstanceType<typeof RentalError>).code).toBe(
      "recien_tomada"
    );

    // Y en la base quedó exactamente UNA reserva activa de ese rango.
    const rows = await db
      .select({ id: schema.rental.id })
      .from(schema.rental)
      .where(
        and(
          eq(schema.rental.organizationId, orgId),
          eq(schema.rental.unitId, unitA),
          sql`${schema.rental.status} in ('tentativa','confirmada','en_curso')`,
          sql`${schema.rental.period} && tstzrange(${period.from.toISOString()}, ${period.to.toISOString()})`
        )
      );
    expect(rows).toHaveLength(1);
  });
});

describe.runIf(!dbAvailable)("inventario contra Postgres real (saltada)", () => {
  it.skip("sin DATABASE_URL accesible esta suite no corre", () => {});
});

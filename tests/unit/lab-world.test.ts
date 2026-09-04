import { readFileSync } from "node:fs";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * 017 Fase 7 — El calendario del Laboratorio contra Postgres REAL.
 *
 * La propiedad que se prueba acá es la que hace que el banco de pruebas sea
 * usable: los dos mundos son DISJUNTOS en las dos direcciones. Una corrida del
 * Lab no puede hacer que un lead real escuche "no hay", y el calendario real
 * no puede cambiar el resultado de una corrida (un score que sube y baja según
 * lo que el dueño alquiló esa semana no mide al agente).
 *
 * Corre solo si hay Postgres accesible; sin base, se salta (igual que
 * inventory-db.test.ts).
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
const T0 = Date.parse("2027-06-01T00:00:00.000Z");
const day = (n: number) => new Date(T0 + n * DAY_MS);

describe.runIf(dbAvailable)("mundo de pruebas del Laboratorio", () => {
  let orgId: string;
  let catId: string;
  let modelId: string;
  let unitId: string;

  beforeAll(async () => {
    const { getDb, schema } = await import("@/lib/db");
    const { newId } = await import("@/lib/db/ids");
    const db = getDb();

    orgId = newId("organization");
    await db.insert(schema.organization).values({
      id: orgId,
      name: "Test Lab",
      slug: `test-lab-${orgId.slice(-8)}`,
      createdAt: new Date(),
    });

    catId = newId("machineCategory");
    await db.insert(schema.machineCategory).values({
      id: catId,
      organizationId: orgId,
      name: "Retroexcavadoras",
      // El fixture busca esta categoría por slug.
      slug: "retroexcavadoras",
    });

    modelId = newId("machineModel");
    await db.insert(schema.machineModel).values({
      id: modelId,
      organizationId: orgId,
      categoryId: catId,
      name: "Retroexcavadora CAT 416F2",
      brand: "Caterpillar",
    });

    unitId = newId("machineUnit");
    await db.insert(schema.machineUnit).values({
      id: unitId,
      organizationId: orgId,
      modelId,
      internalCode: "LAB-01",
      usageHours: 10,
    });
  });

  afterAll(async () => {
    if (!orgId) return;
    const { getDb, schema } = await import("@/lib/db");
    const db = getDb();
    await db.delete(schema.rentalOffer).where(eq(schema.rentalOffer.organizationId, orgId));
    await db.delete(schema.rental).where(eq(schema.rental.organizationId, orgId));
    await db.delete(schema.machineUnit).where(eq(schema.machineUnit.organizationId, orgId));
    await db.delete(schema.machineModel).where(eq(schema.machineModel.organizationId, orgId));
    await db.delete(schema.organization).where(eq(schema.organization.id, orgId));
  });

  it("una reserva de prueba NO le tapa la máquina a un lead real", async () => {
    const { getDb, schema } = await import("@/lib/db");
    const { newId } = await import("@/lib/db/ids");
    const { findAvailableUnits } = await import("@/server/inventory/availability");
    const db = getDb();

    const rentalId = newId("rental");
    await db.insert(schema.rental).values({
      id: rentalId,
      organizationId: orgId,
      unitId,
      period: { from: day(10), to: day(20) },
      status: "confirmada",
      isTest: true,
    });

    // Mundo real: libre. Es la garantía que protege al negocio.
    const real = await findAvailableUnits(orgId, modelId, { from: day(12), to: day(15) }, 0, false);
    expect(real.map((u) => u.id)).toEqual([unitId]);

    // Mundo de pruebas: ocupada. Es lo que hace evaluable a la persona
    // `fechas_ocupadas`.
    const test = await findAvailableUnits(orgId, modelId, { from: day(12), to: day(15) }, 0, true);
    expect(test).toEqual([]);

    await db.delete(schema.rental).where(eq(schema.rental.id, rentalId));
  });

  it("una reserva real NO altera lo que ve el Laboratorio", async () => {
    const { getDb, schema } = await import("@/lib/db");
    const { newId } = await import("@/lib/db/ids");
    const { findAvailableUnits } = await import("@/server/inventory/availability");
    const db = getDb();

    const rentalId = newId("rental");
    await db.insert(schema.rental).values({
      id: rentalId,
      organizationId: orgId,
      unitId,
      period: { from: day(30), to: day(40) },
      status: "confirmada",
    });

    const test = await findAvailableUnits(orgId, modelId, { from: day(32), to: day(35) }, 0, true);
    expect(test.map((u) => u.id)).toEqual([unitId]);

    await db.delete(schema.rental).where(eq(schema.rental.id, rentalId));
  });

  it("el anti-solape también protege al mundo de pruebas", async () => {
    const { getDb, schema } = await import("@/lib/db");
    const { newId } = await import("@/lib/db/ids");
    const db = getDb();

    const first = newId("rental");
    await db.insert(schema.rental).values({
      id: first,
      organizationId: orgId,
      unitId,
      period: { from: day(50), to: day(60) },
      status: "tentativa",
      isTest: true,
    });

    // Dos personas simuladas no pueden quedarse con la misma máquina: si esto
    // pasara, el Lab nunca vería el conflicto que en producción sí ocurre.
    await expect(
      db.insert(schema.rental).values({
        id: newId("rental"),
        organizationId: orgId,
        unitId,
        period: { from: day(55), to: day(65) },
        status: "tentativa",
        isTest: true,
      })
    ).rejects.toThrow();

    // …pero una reserva REAL sobre el mismo rango sí entra: son dos
    // calendarios, no uno con excepciones.
    const real = newId("rental");
    await db.insert(schema.rental).values({
      id: real,
      organizationId: orgId,
      unitId,
      period: { from: day(55), to: day(65) },
      status: "tentativa",
    });

    await db.delete(schema.rental).where(eq(schema.rental.id, first));
    await db.delete(schema.rental).where(eq(schema.rental.id, real));
  });

  it("prepareTestWorld ocupa la retro y borra el mundo de la corrida anterior", async () => {
    const { getDb, schema } = await import("@/lib/db");
    const { newId } = await import("@/lib/db/ids");
    const { prepareTestWorld } = await import("@/server/lab/fixtures");
    const { findAvailableUnits } = await import("@/server/inventory/availability");
    const db = getDb();

    // Basura de una corrida anterior que debe desaparecer.
    const stale = newId("rental");
    await db.insert(schema.rental).values({
      id: stale,
      organizationId: orgId,
      unitId,
      period: { from: day(200), to: day(210) },
      status: "tentativa",
      isTest: true,
    });

    const now = new Date(T0);
    const fixtures = await prepareTestWorld(orgId, now);
    expect(fixtures.blockedModel?.id).toBe(modelId);
    expect(fixtures.blockedUnits).toBe(1);

    const rows = await db
      .select({ id: schema.rental.id })
      .from(schema.rental)
      .where(eq(schema.rental.id, stale));
    expect(rows).toEqual([]);

    // La ventana de la corrida quedó ocupada en el mundo de pruebas…
    const enPruebas = await findAvailableUnits(
      orgId,
      modelId,
      { from: fixtures.window.from, to: fixtures.window.to },
      0,
      true
    );
    expect(enPruebas).toEqual([]);
    // …y libre en el real.
    const enReal = await findAvailableUnits(
      orgId,
      modelId,
      { from: fixtures.window.from, to: fixtures.window.to },
      0,
      false
    );
    expect(enReal.map((u) => u.id)).toEqual([unitId]);

    await db.delete(schema.rental).where(eq(schema.rental.organizationId, orgId));
  });

  it("las reservas de prueba no salen en la pantalla de operación", async () => {
    const { getDb, schema } = await import("@/lib/db");
    const { newId } = await import("@/lib/db/ids");
    const { listRentals } = await import("@/server/inventory/queries");
    const db = getDb();

    const real = newId("rental");
    const prueba = newId("rental");
    await db.insert(schema.rental).values([
      {
        id: real,
        organizationId: orgId,
        unitId,
        period: { from: day(300), to: day(305) },
        status: "confirmada",
      },
      {
        id: prueba,
        organizationId: orgId,
        unitId,
        period: { from: day(300), to: day(305) },
        status: "confirmada",
        isTest: true,
      },
    ]);

    const listed = await listRentals(orgId);
    expect(listed.map((r) => r.id)).toContain(real);
    expect(listed.map((r) => r.id)).not.toContain(prueba);

    await db.delete(schema.rental).where(eq(schema.rental.id, real));
    await db.delete(schema.rental).where(eq(schema.rental.id, prueba));
  });
});

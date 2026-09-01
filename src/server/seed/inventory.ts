import { eq } from "drizzle-orm";
import type { getDb } from "@/lib/db";
import { schema } from "@/lib/db";
import { newId } from "@/lib/db/ids";

/**
 * 017 — Seed de inventario para RPM Construcciones: flota y tarifario
 * realistas de alquiler de maquinaria en Argentina (montos en centavos ARS).
 *
 * Idempotente: borra el inventario previo de la organización y reinserta,
 * en orden inverso de FKs. Incluye una reserva confirmada y un bloqueo de
 * mantenimiento para que la disponibilidad tenga algo real que esquivar
 * desde el primer día.
 */

type Db = ReturnType<typeof getDb>;

const DAY = 24 * 60 * 60 * 1000;
/** $1.000 ARS → centavos. */
const K = 100_000;

function day(offset: number): Date {
  const d = new Date();
  d.setUTCHours(0, 0, 0, 0);
  return new Date(d.getTime() + offset * DAY);
}

export async function seedInventory(db: Db, organizationId: string) {
  // Orden inverso de FKs; rental primero porque referencia unidades.
  await db
    .delete(schema.rentalOffer)
    .where(eq(schema.rentalOffer.organizationId, organizationId));
  await db
    .delete(schema.rental)
    .where(eq(schema.rental.organizationId, organizationId));
  await db
    .delete(schema.rateCard)
    .where(eq(schema.rateCard.organizationId, organizationId));
  await db
    .delete(schema.machineUnit)
    .where(eq(schema.machineUnit.organizationId, organizationId));
  await db
    .delete(schema.machineModel)
    .where(eq(schema.machineModel.organizationId, organizationId));
  await db
    .delete(schema.machineCategory)
    .where(eq(schema.machineCategory.organizationId, organizationId));

  const categories = [
    { slug: "retroexcavadoras", name: "Retroexcavadoras" },
    { slug: "minicargadoras", name: "Minicargadoras" },
    { slug: "hidrogruas", name: "Hidrogrúas" },
    { slug: "compactadores", name: "Compactadores" },
  ].map((c, i) => ({
    id: newId("machineCategory"),
    organizationId,
    name: c.name,
    slug: c.slug,
    position: i,
  }));
  await db.insert(schema.machineCategory).values(categories);
  const cat = Object.fromEntries(categories.map((c) => [c.slug, c.id]));

  const models: (typeof schema.machineModel.$inferInsert)[] = [
    {
      id: newId("machineModel"),
      organizationId,
      categoryId: cat["retroexcavadoras"]!,
      name: "Retroexcavadora JCB 3CX",
      brand: "JCB",
      specs: {
        potencia_hp: 92,
        prof_excavacion_m: 5.46,
        capacidad_balde_m3: 1.0,
        peso_t: 8.2,
        traccion: "4x4",
      },
      description:
        "Retro combinada 4x4 con balde frontal y brazo excavador. La más pedida para zanjeo, movimiento de suelo y carga en obra urbana.",
      photos: [],
      requiresOperator: false,
      active: true,
    },
    {
      id: newId("machineModel"),
      organizationId,
      categoryId: cat["retroexcavadoras"]!,
      name: "Retroexcavadora CAT 416F2",
      brand: "Caterpillar",
      specs: {
        potencia_hp: 87,
        prof_excavacion_m: 4.36,
        capacidad_balde_m3: 0.96,
        peso_t: 7.5,
        traccion: "4x2",
      },
      description:
        "Retro 4x2 confiable para zanjeo y saneamiento. Menor porte que la 3CX; entra mejor en calles angostas.",
      photos: [],
      requiresOperator: false,
      active: true,
    },
    {
      id: newId("machineModel"),
      organizationId,
      categoryId: cat["minicargadoras"]!,
      name: "Minicargadora Bobcat S570",
      brand: "Bobcat",
      specs: {
        potencia_hp: 61,
        capacidad_operativa_kg: 962,
        peso_t: 2.9,
        accesorios: ["balde", "pala 4en1", "pastera"],
      },
      description:
        "Minicargadora compacta para movimiento de áridos, limpieza de obra y patios. Acepta accesorios de enganche rápido.",
      photos: [],
      requiresOperator: false,
      active: true,
    },
    {
      id: newId("machineModel"),
      organizationId,
      categoryId: cat["hidrogruas"]!,
      name: "Hidrogrúa Palfinger PK 12000 s/camión",
      brand: "Palfinger",
      specs: {
        momento_tm: 11.6,
        alcance_max_m: 12.6,
        capacidad_punta_kg: 890,
        camion: "Ford Cargo 1723",
      },
      description:
        "Hidrogrúa articulada montada sobre camión. Izaje y descarga de materiales en obra. Se alquila SIEMPRE con operario habilitado.",
      photos: [],
      requiresOperator: true,
      active: true,
    },
    {
      id: newId("machineModel"),
      organizationId,
      categoryId: cat["compactadores"]!,
      name: "Rodillo compactador JCB VMT 260",
      brand: "JCB",
      specs: {
        peso_t: 2.7,
        ancho_tambor_m: 1.2,
        tipo: "tandem vibratorio",
      },
      description:
        "Rodillo doble tambor vibratorio para bases, sub-bases y asfalto en caliente. Ideal veredas, playones y calles internas.",
      photos: [],
      requiresOperator: false,
      active: true,
    },
  ];
  await db.insert(schema.machineModel).values(models);
  const modelByName = Object.fromEntries(models.map((m) => [m.name, m.id!]));

  const units: (typeof schema.machineUnit.$inferInsert)[] = [
    // Dos 3CX iguales: el caso "1 de 2 libre" que justifica modelo↔unidad.
    { model: "Retroexcavadora JCB 3CX", code: "RETRO-01", year: 2019, hours: 6200 },
    { model: "Retroexcavadora JCB 3CX", code: "RETRO-02", year: 2022, hours: 2400 },
    { model: "Retroexcavadora CAT 416F2", code: "RETRO-03", year: 2017, hours: 8900 },
    { model: "Minicargadora Bobcat S570", code: "MINI-01", year: 2021, hours: 3100 },
    { model: "Minicargadora Bobcat S570", code: "MINI-02", year: 2023, hours: 900 },
    { model: "Hidrogrúa Palfinger PK 12000 s/camión", code: "GRUA-01", year: 2018, hours: 5400 },
    { model: "Rodillo compactador JCB VMT 260", code: "RODI-01", year: 2020, hours: 2800 },
  ].map((u) => ({
    id: newId("machineUnit"),
    organizationId,
    modelId: modelByName[u.model]!,
    internalCode: u.code,
    year: u.year,
    usageHours: u.hours,
    status: "operativa" as const,
  }));
  await db.insert(schema.machineUnit).values(units);
  const unitByCode = Object.fromEntries(units.map((u) => [u.internalCode, u.id!]));

  // Tarifas ARS ago-2026 (centavos): diaria / semanal / mensual + extras.
  const rates: (typeof schema.rateCard.$inferInsert)[] = [
    {
      model: "Retroexcavadora JCB 3CX",
      daily: 210 * K,
      weekly: 1_150 * K,
      monthly: 3_900 * K,
    },
    {
      model: "Retroexcavadora CAT 416F2",
      daily: 185 * K,
      weekly: 1_000 * K,
      monthly: 3_400 * K,
    },
    {
      model: "Minicargadora Bobcat S570",
      daily: 120 * K,
      weekly: 650 * K,
      monthly: 2_200 * K,
    },
    {
      model: "Hidrogrúa Palfinger PK 12000 s/camión",
      daily: 260 * K,
      weekly: 1_400 * K,
      monthly: null,
      operator: 85 * K,
    },
    {
      model: "Rodillo compactador JCB VMT 260",
      daily: 95 * K,
      weekly: 520 * K,
      monthly: 1_750 * K,
    },
  ].map((r) => ({
    id: newId("rateCard"),
    organizationId,
    modelId: modelByName[r.model]!,
    dailyCents: r.daily,
    weeklyCents: r.weekly,
    monthlyCents: r.monthly ?? null,
    transferBaseCents: 60 * K,
    transferPerKmCents: 1_200_00, // $1.200/km
    operatorDailyCents: (r as { operator?: number }).operator ?? 0,
    validFrom: day(-30),
  }));
  await db.insert(schema.rateCard).values(rates);

  // Ocupación inicial: la disponibilidad tiene que esquivar algo real.
  await db.insert(schema.rental).values([
    {
      id: newId("rental"),
      organizationId,
      unitId: unitByCode["RETRO-01"]!,
      kind: "alquiler",
      period: { from: day(-2), to: day(8) },
      status: "confirmada",
      createdBy: "humano",
      quotedAmountCents: 1_150 * K,
      withTransfer: true,
      siteLocation: "Obra en Malagueño, Córdoba",
      notes: "Seed: alquiler confirmado en curso",
    },
    {
      id: newId("rental"),
      organizationId,
      unitId: unitByCode["RODI-01"]!,
      kind: "mantenimiento",
      period: { from: day(3), to: day(6) },
      status: "confirmada",
      createdBy: "humano",
      notes: "Seed: service de 250 hs programado",
    },
  ]);

  return {
    categories: categories.length,
    models: models.length,
    units: units.length,
    rates: rates.length,
    rentals: 2,
  };
}

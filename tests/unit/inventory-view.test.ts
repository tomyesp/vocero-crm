import { describe, expect, it } from "vitest";
import type { Catalog, RentalListItem } from "@/server/inventory/queries";
import {
  DAY_MS,
  WINDOW_DAYS,
  busyDaysByUnit,
  startOfToday,
  todayView,
} from "@/lib/inventory-view";

/**
 * 017 — La aritmética de /reservas.
 *
 * Es lo único de esa pantalla que puede estar mal sin que se note: un día
 * corrido o un día de devolución contado como ocupado no rompe nada, se ve
 * como una disponibilidad plausible y equivocada. En un negocio de alquiler
 * eso es peor que un error visible: se le dice "no hay" a alguien que sí
 * podía llevarse la máquina.
 */

const AHORA = new Date("2026-09-15T10:30:00");
const DIA0 = startOfToday(AHORA);

/** Un catálogo mínimo: un modelo con dos unidades. */
function catalogo(estadoU2: "operativa" | "mantenimiento" = "operativa"): Catalog {
  return {
    categories: [{ id: "cat1", name: "Retroexcavadoras", slug: "retro", position: 0 }],
    models: [
      {
        id: "mod1",
        categoryId: "cat1",
        name: "Retroexcavadora 416E",
        brand: "Caterpillar",
        specs: {},
        description: null,
        photos: [],
        requiresOperator: true,
        active: true,
        units: [
          { id: "u1", internalCode: "RETRO-01", year: null, usageHours: 0, status: "operativa", notes: null },
          { id: "u2", internalCode: "RETRO-02", year: null, usageHours: 0, status: estadoU2, notes: null },
        ],
        currentRate: null,
      },
    ],
  } as unknown as Catalog;
}

/** Una reserva con lo mínimo que mira la vista. */
function reserva(over: Partial<RentalListItem> & { from: string; to: string }): RentalListItem {
  return {
    id: "r1",
    kind: "alquiler",
    status: "confirmada",
    expiresAt: null,
    createdBy: "humano",
    hoursPerDay: 8,
    quotedAmountCents: null,
    withTransfer: false,
    siteLocation: null,
    notes: null,
    isTest: false,
    unit: { id: "u1", internalCode: "RETRO-01" },
    model: { id: "mod1", name: "Retroexcavadora 416E" },
    contact: null,
    conversationId: null,
    createdAt: new Date(DIA0).toISOString(),
    ...over,
  } as RentalListItem;
}

const dia = (n: number) => new Date(DIA0 + n * DAY_MS).toISOString();

describe("días ocupados por unidad", () => {
  it("el día de devolución queda LIBRE: el período es [desde, hasta)", () => {
    const busy = busyDaysByUnit(
      [reserva({ from: dia(2), to: dia(5) })],
      catalogo(),
      DIA0
    );
    const dias = busy.get("u1")!;
    expect([...dias].sort((a, b) => a - b)).toEqual([2, 3, 4]);
    // El 5 es el día que vuelve: ese día ya se puede volver a alquilar.
    expect(dias.has(5)).toBe(false);
  });

  it("una reserva que arrancó ANTES de hoy se recorta a la ventana", () => {
    const busy = busyDaysByUnit(
      [reserva({ status: "en_curso", from: dia(-10), to: dia(2) })],
      catalogo(),
      DIA0
    );
    expect([...busy.get("u1")!].sort((a, b) => a - b)).toEqual([0, 1]);
  });

  it("una reserva que se pasa del horizonte no desborda", () => {
    const busy = busyDaysByUnit(
      [reserva({ from: dia(26), to: dia(60) })],
      catalogo(),
      DIA0
    );
    const dias = [...busy.get("u1")!];
    expect(Math.max(...dias)).toBe(WINDOW_DAYS - 1);
  });

  it("una unidad en mantenimiento ocupa toda la ventana, sin reservas", () => {
    const busy = busyDaysByUnit([], catalogo("mantenimiento"), DIA0);
    expect(busy.get("u2")!.size).toBe(WINDOW_DAYS);
    expect(busy.get("u1")).toBeUndefined();
  });

  it("las canceladas y finalizadas no ocupan nada", () => {
    const busy = busyDaysByUnit(
      [
        reserva({ id: "r1", status: "cancelada", from: dia(1), to: dia(4) }),
        reserva({ id: "r2", status: "finalizada", from: dia(1), to: dia(4) }),
      ],
      catalogo(),
      DIA0
    );
    expect(busy.get("u1")).toBeUndefined();
  });

  it("dos reservas de la misma unidad se suman en el mismo set", () => {
    const busy = busyDaysByUnit(
      [
        reserva({ id: "r1", from: dia(1), to: dia(3) }),
        reserva({ id: "r2", from: dia(6), to: dia(8) }),
      ],
      catalogo(),
      DIA0
    );
    expect([...busy.get("u1")!].sort((a, b) => a - b)).toEqual([1, 2, 6, 7]);
  });
});

describe("lo que hay que decidir hoy", () => {
  it("una confirmada que arranca hoy sale en 'salen'", () => {
    const v = todayView([reserva({ from: dia(0), to: dia(3) })], AHORA);
    expect(v.salen).toHaveLength(1);
    expect(v.pendientes[0]!.reason).toBe("sale_hoy");
  });

  it("una confirmada que tenía que salir ayer se marca ATRASADA y urgente", () => {
    const v = todayView([reserva({ from: dia(-1), to: dia(3) })], AHORA);
    expect(v.salen).toHaveLength(0);
    expect(v.pendientes[0]).toMatchObject({ reason: "atrasada", urgent: true });
  });

  it("una en curso que vuelve hoy sale en 'vuelven'", () => {
    const v = todayView(
      [reserva({ status: "en_curso", from: dia(-3), to: dia(0) })],
      AHORA
    );
    expect(v.vuelven).toHaveLength(1);
  });

  it("una tentativa que vence dentro de 24 h es urgente; una de 3 días no", () => {
    const pronto = reserva({
      id: "r1",
      status: "tentativa",
      from: dia(4),
      to: dia(6),
      expiresAt: new Date(AHORA.getTime() + 3 * 60 * 60 * 1000).toISOString(),
    });
    const lejos = reserva({
      id: "r2",
      status: "tentativa",
      from: dia(4),
      to: dia(6),
      expiresAt: new Date(AHORA.getTime() + 3 * DAY_MS).toISOString(),
    });
    const v = todayView([pronto, lejos], AHORA);
    expect(v.vencen.map((r) => r.id)).toEqual(["r1"]);
  });

  it("lo que se pierde solo va PRIMERO: urgentes arriba", () => {
    const v = todayView(
      [
        reserva({ id: "sale", from: dia(0), to: dia(3) }),
        reserva({
          id: "vence",
          status: "tentativa",
          from: dia(4),
          to: dia(6),
          expiresAt: new Date(AHORA.getTime() + 60 * 60 * 1000).toISOString(),
        }),
      ],
      AHORA
    );
    expect(v.pendientes.map((p) => p.rental.id)).toEqual(["vence", "sale"]);
  });

  it("sin nada que decidir, la lista queda vacía (no inventa filas)", () => {
    const v = todayView([reserva({ from: dia(5), to: dia(9) })], AHORA);
    expect(v.pendientes).toHaveLength(0);
  });
});

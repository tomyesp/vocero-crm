import { describe, expect, it } from "vitest";
import { computeQuote, IVA_PCT } from "@/server/inventory/quote";

/**
 * 017 — El motor de cotización es puro a propósito: mismos números para el
 * endpoint del bot y para el simulador de la UI. Acá se fijan la tarifa
 * escalonada, los extras y el IVA.
 */

const RATE = {
  dailyCents: 210_000_00, // $210.000
  weeklyCents: 1_150_000_00, // $1.150.000
  monthlyCents: 3_900_000_00, // $3.900.000
  transferBaseCents: 60_000_00,
  transferPerKmCents: 1_200_00,
  operatorDailyCents: 85_000_00,
};

const BASE_INPUT = { withTransfer: false, requiresOperator: false };

describe("tarifa escalonada", () => {
  it("menos de 7 días cotiza con la diaria", () => {
    const q = computeQuote(RATE, { ...BASE_INPUT, days: 6 });
    expect(q.tier).toBe("diaria");
    expect(q.baseCents).toBe(6 * RATE.dailyCents);
  });

  it("7 días exactos saltan al escalón semanal", () => {
    const q = computeQuote(RATE, { ...BASE_INPUT, days: 7 });
    expect(q.tier).toBe("semanal");
    expect(q.baseCents).toBe(RATE.weeklyCents);
  });

  it("10 días prorratean la semanal (y salen más baratos que 10 diarias)", () => {
    const q = computeQuote(RATE, { ...BASE_INPUT, days: 10 });
    expect(q.tier).toBe("semanal");
    expect(q.baseCents).toBe(Math.round((RATE.weeklyCents * 10) / 7));
    expect(q.baseCents).toBeLessThan(10 * RATE.dailyCents);
  });

  it("30 días exactos cotizan la mensual completa", () => {
    const q = computeQuote(RATE, { ...BASE_INPUT, days: 30 });
    expect(q.tier).toBe("mensual");
    expect(q.baseCents).toBe(RATE.monthlyCents);
  });

  it("45 días prorratean la mensual", () => {
    const q = computeQuote(RATE, { ...BASE_INPUT, days: 45 });
    expect(q.tier).toBe("mensual");
    expect(q.baseCents).toBe(Math.round((RATE.monthlyCents * 45) / 30));
  });

  it("sin escalón mensual definido, 30+ días caen a la semanal — nunca se inventa un precio", () => {
    const q = computeQuote({ ...RATE, monthlyCents: null }, { ...BASE_INPUT, days: 40 });
    expect(q.tier).toBe("semanal");
    expect(q.baseCents).toBe(Math.round((RATE.weeklyCents * 40) / 7));
  });

  it("sin semanal ni mensual todo es diaria", () => {
    const q = computeQuote(
      { ...RATE, weeklyCents: null, monthlyCents: null },
      { ...BASE_INPUT, days: 40 }
    );
    expect(q.tier).toBe("diaria");
    expect(q.baseCents).toBe(40 * RATE.dailyCents);
  });
});

describe("extras y total", () => {
  it("traslado = base + km × costo/km, solo si se pide", () => {
    const con = computeQuote(RATE, { ...BASE_INPUT, days: 3, withTransfer: true, km: 25 });
    expect(con.transferCents).toBe(RATE.transferBaseCents + 25 * RATE.transferPerKmCents);
    const sin = computeQuote(RATE, { ...BASE_INPUT, days: 3, km: 25 });
    expect(sin.transferCents).toBe(0);
  });

  it("el operario se cobra por día cuando el modelo lo exige", () => {
    const q = computeQuote(RATE, { days: 5, withTransfer: false, requiresOperator: true });
    expect(q.operatorCents).toBe(5 * RATE.operatorDailyCents);
  });

  it("IVA sobre el subtotal y desglose que cierra", () => {
    const q = computeQuote(RATE, { days: 10, withTransfer: true, km: 40, requiresOperator: true });
    expect(q.subtotalCents).toBe(q.baseCents + q.transferCents + q.operatorCents);
    expect(q.ivaCents).toBe(Math.round((q.subtotalCents * IVA_PCT) / 100));
    expect(q.totalCents).toBe(q.subtotalCents + q.ivaCents);
  });

  it("días inválidos revientan en vez de cotizar cualquier cosa", () => {
    expect(() => computeQuote(RATE, { ...BASE_INPUT, days: 0 })).toThrow();
    expect(() => computeQuote(RATE, { ...BASE_INPUT, days: 1.5 })).toThrow();
  });
});

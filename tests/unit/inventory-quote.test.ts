import { describe, expect, it } from "vitest";
import { computeQuote, FULL_DAY_HOURS } from "@/server/inventory/quote";

/**
 * 017 — El motor de cotización es puro a propósito: mismos números para el
 * endpoint del bot y para el simulador de la UI. Acá se fija cómo cotiza RPM:
 * la HORA de máquina, con operario y combustible adentro, SIN IVA, y el
 * traslado como único extra.
 */

const RATE = {
  hourlyCents: 32_000_00, // $32.000 la hora
  minHours: 0,
  transferBaseCents: 60_000_00,
  transferPerKmCents: 1_200_00,
};

const BASE_INPUT = { hoursPerDay: 8, withTransfer: false };

describe("precio por hora", () => {
  it("el total es días × horas por día × tarifa", () => {
    const q = computeQuote(RATE, { ...BASE_INPUT, days: 3 });
    expect(q.requestedHours).toBe(24);
    expect(q.machineCents).toBe(24 * RATE.hourlyCents);
    expect(q.totalCents).toBe(24 * RATE.hourlyCents);
  });

  it("media jornada sale la mitad que la jornada completa", () => {
    const media = computeQuote(RATE, { days: 2, hoursPerDay: 4, withTransfer: false });
    const entera = computeQuote(RATE, { days: 2, hoursPerDay: 8, withTransfer: false });
    expect(media.machineCents * 2).toBe(entera.machineCents);
  });

  it("no hay escalones: 30 días valen 30 veces un día", () => {
    const uno = computeQuote(RATE, { ...BASE_INPUT, days: 1 });
    const treinta = computeQuote(RATE, { ...BASE_INPUT, days: 30 });
    expect(treinta.machineCents).toBe(30 * uno.machineCents);
  });

  it("horas fraccionarias se redondean UNA vez, al final", () => {
    const q = computeQuote({ ...RATE, hourlyCents: 33_333_33 }, { days: 1, hoursPerDay: 4.5, withTransfer: false });
    expect(q.machineCents).toBe(Math.round(33_333_33 * 4.5));
  });
});

describe("mínimo de horas", () => {
  it("sin mínimo se factura exactamente lo pedido", () => {
    const q = computeQuote(RATE, { days: 1, hoursPerDay: 2, withTransfer: false });
    expect(q.billedHours).toBe(2);
    expect(q.machineCents).toBe(2 * RATE.hourlyCents);
  });

  it("un trabajo más corto que el mínimo se cobra el mínimo", () => {
    const q = computeQuote({ ...RATE, minHours: 4 }, { days: 1, hoursPerDay: 2, withTransfer: false });
    expect(q.requestedHours).toBe(2);
    expect(q.billedHours).toBe(4);
    expect(q.machineCents).toBe(4 * RATE.hourlyCents);
  });

  it("el mínimo es del SERVICIO, no de cada día: 3 días de 2 hs son 6, no 12", () => {
    const q = computeQuote({ ...RATE, minHours: 4 }, { days: 3, hoursPerDay: 2, withTransfer: false });
    expect(q.billedHours).toBe(6);
  });

  it("por encima del mínimo el mínimo no toca nada", () => {
    const q = computeQuote({ ...RATE, minHours: 4 }, { ...BASE_INPUT, days: 1 });
    expect(q.billedHours).toBe(8);
  });
});

describe("traslado y total", () => {
  it("traslado = base + km × costo/km, solo si se pide", () => {
    const con = computeQuote(RATE, { ...BASE_INPUT, days: 3, withTransfer: true, km: 25 });
    expect(con.transferCents).toBe(RATE.transferBaseCents + 25 * RATE.transferPerKmCents);
    const sin = computeQuote(RATE, { ...BASE_INPUT, days: 3, km: 25 });
    expect(sin.transferCents).toBe(0);
  });

  it("el total es máquina + traslado y NADA más: ni operario ni IVA", () => {
    const q = computeQuote(RATE, { ...BASE_INPUT, days: 10, withTransfer: true, km: 40 });
    expect(q.totalCents).toBe(q.machineCents + q.transferCents);
    // El literal `false` es el contrato: nadie puede leer este desglose y
    // creer que el número ya trae IVA.
    expect(q.includesVat).toBe(false);
  });

  it("una jornada completa son 8 horas en todo el sistema", () => {
    expect(FULL_DAY_HOURS).toBe(8);
  });

  it("días u horas inválidos revientan en vez de cotizar cualquier cosa", () => {
    expect(() => computeQuote(RATE, { ...BASE_INPUT, days: 0 })).toThrow();
    expect(() => computeQuote(RATE, { ...BASE_INPUT, days: 1.5 })).toThrow();
    expect(() => computeQuote(RATE, { days: 1, hoursPerDay: 0, withTransfer: false })).toThrow();
    expect(() => computeQuote(RATE, { days: 1, hoursPerDay: 25, withTransfer: false })).toThrow();
  });
});

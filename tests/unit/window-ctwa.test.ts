import { describe, expect, it } from "vitest";
import {
  CTWA_WINDOW_MS,
  isWindowOpen,
  WINDOW_MS,
  windowRemainingMs,
} from "@/server/inbox/window";

/**
 * 017 — Ventana dependiente del origen: un lead de anuncio CTWA tiene 72h de
 * texto libre desde el click, además de las 24h del último entrante. Sin
 * `ctwaStartedAt`, la regla de siempre no cambia ni un milímetro.
 */

const H = 60 * 60 * 1000;
const NOW = new Date("2026-09-02T12:00:00Z");
const hoursAgo = (h: number) => new Date(NOW.getTime() - h * H);

describe("ventana 24h (sin origen de anuncio)", () => {
  it("abierta a las 23h del último entrante, cerrada a las 25h", () => {
    expect(isWindowOpen(hoursAgo(23), NOW)).toBe(true);
    expect(isWindowOpen(hoursAgo(25), NOW)).toBe(false);
  });

  it("sin entrantes, cerrada", () => {
    expect(isWindowOpen(null, NOW)).toBe(false);
    expect(windowRemainingMs(null, NOW)).toBe(0);
  });
});

describe("ventana 72h de anuncio CTWA", () => {
  it("a las 30h del click sigue abierta aunque las 24h del entrante pasaron", () => {
    expect(isWindowOpen(hoursAgo(30), NOW, hoursAgo(30))).toBe(true);
  });

  it("a las 73h del click, manda la regla de 24h del último entrante", () => {
    expect(isWindowOpen(hoursAgo(73), NOW, hoursAgo(73))).toBe(false);
    // …y si el lead volvió a escribir hace 1h, abierta como siempre.
    expect(isWindowOpen(hoursAgo(1), NOW, hoursAgo(73))).toBe(true);
  });

  it("un lead orgánico (ctwaStartedAt null) no gana nada", () => {
    expect(isWindowOpen(hoursAgo(30), NOW, null)).toBe(false);
  });

  it("el restante es el MAYOR de las dos ventanas", () => {
    // Click hace 30h (quedan 42h de CTWA), entrante hace 1h (quedan 23h).
    expect(windowRemainingMs(hoursAgo(1), NOW, hoursAgo(30))).toBe(
      CTWA_WINDOW_MS - 30 * H
    );
    // Click hace 71h (queda 1h de CTWA), entrante hace 1h (quedan 23h).
    expect(windowRemainingMs(hoursAgo(1), NOW, hoursAgo(71))).toBe(
      WINDOW_MS - 1 * H
    );
  });
});

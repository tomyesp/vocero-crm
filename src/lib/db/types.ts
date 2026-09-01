import { customType } from "drizzle-orm/pg-core";

/**
 * 017 — `tstzrange` nativo de Postgres para los períodos de alquiler.
 *
 * Drizzle no trae rangos: este customType guarda el período como UN valor
 * indexable por GiST, que es lo que hace posible el constraint de exclusión
 * anti-solape de `rental` (dos reservas activas de la misma unidad no pueden
 * pisarse NI en una carrera — lo garantiza la base, no el código).
 *
 * Convención del dominio: rango `[desde, hasta)` — el día de devolución queda
 * libre para la siguiente obra. Se serializa en ISO UTC; el driver entrega el
 * texto canónico de Postgres (`["2026-01-10 00:00:00+00","2026-01-20 00:00:00+00")`).
 */
export const tstzrange = customType<{
  data: { from: Date; to: Date };
  driverData: string;
}>({
  dataType() {
    return "tstzrange";
  },
  toDriver(value) {
    return `[${value.from.toISOString()},${value.to.toISOString()})`;
  },
  fromDriver(value) {
    // Forma canónica: ["<ts>","<ts>") — comillas opcionales según versión.
    const match = value.match(/^[\[(]"?([^",]+)"?\s*,\s*"?([^")\]]+)"?[)\]]$/);
    if (!match || !match[1] || !match[2]) {
      throw new Error(`tstzrange: formato inesperado del driver: ${value}`);
    }
    return { from: new Date(match[1]), to: new Date(match[2]) };
  },
});

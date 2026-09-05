import type { Catalog, RentalListItem } from "@/server/inventory/queries";

/**
 * 017 — La aritmética de la pantalla de reservas, sin React.
 *
 * Vive aparte del componente porque es lo único de esa pantalla que puede
 * estar MAL sin que se note: un día corrido, un día de devolución contado
 * como ocupado, una reserva que arranca antes de la ventana. Nada de eso
 * grita en un screenshot — se ve como una disponibilidad plausible y
 * equivocada, que es la peor clase de error en un negocio de alquiler.
 */

export const DAY_MS = 24 * 60 * 60 * 1000;

/** Cuánto muestra la pantalla hacia adelante. */
export const WINDOW_DAYS = 28;

/** Una tentativa que vence dentro de esto ya es cosa de hoy. */
export const POR_VENCER_MS = 24 * 60 * 60 * 1000;

export const ACTIVOS: RentalListItem["status"][] = [
  "tentativa",
  "confirmada",
  "en_curso",
];

/** Medianoche LOCAL de hoy: el origen de toda la cuenta de días. */
export function startOfToday(now: Date = new Date()): number {
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

export function sameDay(iso: string, day0: number): boolean {
  const t = Date.parse(iso);
  return t >= day0 && t < day0 + DAY_MS;
}

/**
 * Qué días de la ventana ocupa cada unidad.
 *
 * El período es `[desde, hasta)` — el día de devolución NO cuenta ocupado,
 * igual que en el motor de disponibilidad del servidor. Si acá contara, la
 * pantalla mostraría una máquina tomada un día que el agente ya puede vender.
 *
 * Una unidad en mantenimiento ocupa TODA la ventana: no es alquilable aunque
 * no tenga una sola reserva encima.
 */
export function busyDaysByUnit(
  rentals: RentalListItem[],
  catalog: Catalog,
  start: number
): Map<string, Set<number>> {
  const map = new Map<string, Set<number>>();
  const mark = (unitId: string, fromIdx: number, toIdx: number) => {
    let days = map.get(unitId);
    if (!days) map.set(unitId, (days = new Set()));
    for (let i = Math.max(0, fromIdx); i < Math.min(WINDOW_DAYS, toIdx); i++) {
      days.add(i);
    }
  };

  for (const m of catalog.models) {
    for (const u of m.units) {
      if (u.status === "mantenimiento") mark(u.id, 0, WINDOW_DAYS);
    }
  }
  for (const r of rentals) {
    if (!ACTIVOS.includes(r.status)) continue;
    mark(
      r.unit.id,
      Math.floor((Date.parse(r.from) - start) / DAY_MS),
      Math.ceil((Date.parse(r.to) - start) / DAY_MS)
    );
  }
  return map;
}

export type PendingReason =
  | "vence"
  | "atrasada"
  | "sale_hoy"
  | "vuelve_hoy";

export type Pending = {
  rental: RentalListItem;
  reason: PendingReason;
  urgent: boolean;
};

export type TodayView = {
  salen: RentalListItem[];
  vuelven: RentalListItem[];
  vencen: RentalListItem[];
  pendientes: Pending[];
};

/**
 * Lo que necesita una decisión hoy, ordenado por urgencia: primero lo que se
 * pierde solo (una tentativa que expira, una salida que ya debería haber
 * pasado), después lo que simplemente ocurre hoy.
 */
export function todayView(
  rentals: RentalListItem[],
  now: Date = new Date()
): TodayView {
  const day0 = startOfToday(now);
  const t = now.getTime();
  const salen: RentalListItem[] = [];
  const vuelven: RentalListItem[] = [];
  const vencen: RentalListItem[] = [];
  const atrasadas: RentalListItem[] = [];

  for (const r of rentals) {
    if (r.status === "confirmada") {
      if (sameDay(r.from, day0)) salen.push(r);
      else if (Date.parse(r.from) < day0) atrasadas.push(r);
    }
    if (r.status === "en_curso" && sameDay(r.to, day0)) vuelven.push(r);
    if (
      r.status === "tentativa" &&
      r.expiresAt &&
      Date.parse(r.expiresAt) < t + POR_VENCER_MS
    ) {
      vencen.push(r);
    }
  }

  const pendientes: Pending[] = [
    ...vencen.map((r) => ({ rental: r, reason: "vence" as const, urgent: true })),
    ...atrasadas.map((r) => ({ rental: r, reason: "atrasada" as const, urgent: true })),
    ...salen.map((r) => ({ rental: r, reason: "sale_hoy" as const, urgent: false })),
    ...vuelven.map((r) => ({ rental: r, reason: "vuelve_hoy" as const, urgent: false })),
  ];
  return { salen, vuelven, vencen, pendientes };
}

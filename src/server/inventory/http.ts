import { apiError } from "@/lib/api";
import { RentalError } from "@/server/inventory/reservations";

/**
 * 017 — Traducción de `RentalError` a HTTP, calcando `agenda/http.ts`.
 * Los 409 llevan las alternativas EN el body: un conflicto sin salida es un
 * lead perdido, y Nea espera poder re-ofrecer en el mismo turno.
 */

const STATUS: Record<RentalError["code"], number> = {
  oferta_desconocida: 409,
  oferta_vencida: 409,
  recien_tomada: 409,
  reserva_inexistente: 404,
  conversacion_inexistente: 404,
  ya_tiene_reserva: 409,
};

export function rentalErrorResponse(err: RentalError): Response {
  const status = STATUS[err.code] ?? 500;
  if (err.code === "recien_tomada") {
    return Response.json(
      {
        error: { code: err.code, message: err.message },
        // Ofertas frescas de la misma máquina (reservables ya) y/o otras
        // máquinas de la categoría (requieren re-consultar disponibilidad).
        ofertas: (err.offers ?? []).map((o) => ({
          ofertaId: o.offerId,
          modeloId: o.modelId,
          desde: o.period.from.toISOString(),
          hasta: o.period.to.toISOString(),
          montoCotizadoCents: o.quotedAmountCents,
          etiqueta: o.label,
          expiraEn: o.expiresAt.toISOString(),
        })),
        alternativas: (err.alternatives ?? []).map((a) => ({
          modeloId: a.modelId,
          nombre: a.name,
          marca: a.brand,
          tarifaDiariaCents: a.dailyCents,
        })),
      },
      { status }
    );
  }
  // 017 Fase 7 (bis) — El agente intentó tomar una SEGUNDA máquina para un
  // lead que ya tiene una tomada. La reserva que ya existe viaja en el body:
  // sin ella, el agente sabe que falló pero no qué mover.
  if (err.code === "ya_tiene_reserva" && err.existing) {
    const r = err.existing;
    return Response.json(
      {
        error: { code: err.code, message: err.message },
        reservaExistente: {
          reservaId: r.id,
          estado: r.status,
          desde: r.period.from.toISOString().slice(0, 10),
          hasta: r.period.to.toISOString().slice(0, 10),
          montoCotizadoCents: r.quotedAmountCents,
        },
      },
      { status }
    );
  }
  return apiError(status, err.code, err.message);
}

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
  return apiError(status, err.code, err.message);
}

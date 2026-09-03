import { and, eq, inArray, isNull, lt } from "drizzle-orm";
import { getDb, schema } from "@/lib/db";
import { publish } from "@/server/events/bus";
import { inventoryEnabled } from "@/server/inventory/flag";

/**
 * 017 — Expiración de tentativas. Una tentativa que nadie confirmó se libera
 * sola (`expiresAt`), y las ofertas vencidas se barren de paso.
 *
 * Es un `setInterval` guardado en `globalThis`, como el bus y el coalesce del
 * agente: sin colas externas (Constitución II). No filtra por organización a
 * propósito — es mantenimiento de TODA la instancia; los eventos SSE sí se
 * publican por organización.
 */

export const EXPIRATION_INTERVAL_MS = 5 * 60 * 1000;

/** Ofertas vencidas sin consumir se borran tras un día (dejan de servir para auditar el turno). */
const OFFER_SWEEP_AGE_MS = 24 * 60 * 60 * 1000;

const globalForJob = globalThis as unknown as {
  __rpmExpirationTimer?: ReturnType<typeof setInterval>;
};

/** Un pase de expiración. Exportado para tests y para el tick del interval. */
export async function expireTentativesOnce(now: Date = new Date()): Promise<number> {
  const db = getDb();
  const expired = await db
    .update(schema.rental)
    .set({ status: "cancelada", updatedAt: now })
    .where(and(eq(schema.rental.status, "tentativa"), lt(schema.rental.expiresAt, now)))
    .returning({ id: schema.rental.id, organizationId: schema.rental.organizationId });

  for (const r of expired) {
    publish(r.organizationId, { type: "rental.updated", data: { rentalId: r.id } });
  }

  // Barrido de ofertas: vencidas hace más de un día y nunca consumidas.
  const cutoff = new Date(now.getTime() - OFFER_SWEEP_AGE_MS);
  const stale = await db
    .select({ id: schema.rentalOffer.id })
    .from(schema.rentalOffer)
    .where(lt(schema.rentalOffer.expiresAt, cutoff));
  const staleIds = stale.map((s) => s.id);
  if (staleIds.length > 0) {
    // Solo las no consumidas: una consumida es historia de una reserva real.
    await db
      .delete(schema.rentalOffer)
      .where(
        and(
          inArray(schema.rentalOffer.id, staleIds),
          isNull(schema.rentalOffer.consumedAt)
        )
      );
  }

  return expired.length;
}

/** Idempotente: llamarlo dos veces no duplica el timer (dev recarga módulos). */
export function startExpirationJob(): void {
  if (!inventoryEnabled()) return;
  if (globalForJob.__rpmExpirationTimer) return;
  globalForJob.__rpmExpirationTimer = setInterval(() => {
    expireTentativesOnce().catch((err) => {
      console.error("[inventario] pase de expiración falló:", err);
    });
  }, EXPIRATION_INTERVAL_MS);
  // El timer no debe impedir que el proceso termine (tests, scripts).
  globalForJob.__rpmExpirationTimer.unref?.();
  console.log(
    `[boot] inventario: expiración de tentativas cada ${EXPIRATION_INTERVAL_MS / 60000} min`
  );
}

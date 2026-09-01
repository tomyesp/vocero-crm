"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import type { RentalListItem } from "@/server/inventory/queries";
import { Badge } from "@/components/ui/badge";
import { formatMoneyCents } from "@/lib/money";

/**
 * 017 — Reservas del contacto en la ficha de la bandeja. Autocontenido: si el
 * inventario está apagado, el endpoint da 404 y la sección no se muestra —
 * el panel del upstream no necesita saber del flag.
 */

const STATUS_BADGE: Record<
  RentalListItem["status"],
  "default" | "secondary" | "outline" | "success" | "warning" | "destructive"
> = {
  tentativa: "warning",
  confirmada: "success",
  en_curso: "default",
  finalizada: "secondary",
  cancelada: "outline",
};

export function ContactRentals({
  contactId,
  refreshKey = 0,
}: {
  contactId: string;
  refreshKey?: number;
}) {
  const [rentals, setRentals] = useState<RentalListItem[] | null>(null);
  const [available, setAvailable] = useState(true);

  const refresh = useCallback(async () => {
    const res = await fetch(`/api/inventory/rentals?contactId=${contactId}`).catch(
      () => null
    );
    if (!res) return;
    if (res.status === 404) {
      setAvailable(false);
      return;
    }
    if (!res.ok) return;
    setRentals(((await res.json()) as { rentals: RentalListItem[] }).rentals);
  }, [contactId]);

  useEffect(() => {
    void refresh();
  }, [refresh, refreshKey]);

  if (!available || rentals === null || rentals.length === 0) return null;

  return (
    <section className="border-b p-4">
      <p className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-text-3">
        Reservas de maquinaria
      </p>
      <ul className="space-y-2">
        {rentals.slice(0, 5).map((r) => (
          <li key={r.id} className="rounded-sm bg-subtle p-2 text-sm">
            <div className="flex items-center gap-2">
              <span className="min-w-0 flex-1 truncate">{r.model.name}</span>
              <Badge variant={STATUS_BADGE[r.status]}>{r.status}</Badge>
            </div>
            <p className="text-xs text-text-3">
              {r.unit.internalCode} ·{" "}
              {new Date(r.from).toLocaleDateString("es-AR", { day: "numeric", month: "short" })}
              {" → "}
              {new Date(r.to).toLocaleDateString("es-AR", { day: "numeric", month: "short" })}
              {r.quotedAmountCents !== null &&
                ` · ${formatMoneyCents(r.quotedAmountCents, "ARS", "es-AR")}`}
            </p>
          </li>
        ))}
      </ul>
      <Link
        href="/reservas"
        className="mt-2 inline-block text-xs font-medium text-brand-text hover:underline"
      >
        Ver todas en Reservas
      </Link>
    </section>
  );
}

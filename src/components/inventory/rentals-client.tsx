"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import type { Catalog, RentalListItem } from "@/server/inventory/queries";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { formatMoneyCents } from "@/lib/money";
import { cn } from "@/lib/utils";
import { useEvents } from "@/components/use-events";

/**
 * 017 — La pantalla que el dueño mira todos los días: timeline de ocupación
 * por unidad + listado con las transiciones HUMANAS (confirmar, cancelar,
 * iniciar, finalizar). El agente solo llega hasta "tentativa".
 */

const SELECT_CLS =
  "flex h-9 w-full rounded-md border border-input bg-card px-3 text-sm";

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

/** Colores del timeline por estado (tokens del tema, sin literales). */
const BAR_CLS: Record<string, string> = {
  tentativa: "bg-warning-soft",
  confirmada: "bg-brand-soft",
  en_curso: "bg-brand",
  mantenimiento: "bg-border-strong",
};

const DAY_MS = 24 * 60 * 60 * 1000;
const WINDOW_DAYS = 28;

function fmtDate(iso: string): string {
  return new Date(iso).toLocaleDateString("es-AR", { day: "numeric", month: "short" });
}

export function RentalsClient() {
  const [rentals, setRentals] = useState<RentalListItem[] | null>(null);
  const [catalog, setCatalog] = useState<Catalog | null>(null);
  const [statusFilter, setStatusFilter] = useState<string>("activas");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    const query =
      statusFilter === "activas"
        ? "?status=tentativa&status=confirmada&status=en_curso"
        : statusFilter === "todas"
          ? ""
          : `?status=${statusFilter}`;
    const [rentalsRes, catalogRes] = await Promise.all([
      fetch(`/api/inventory/rentals${query}`).catch(() => null),
      fetch("/api/inventory/catalog").catch(() => null),
    ]);
    if (rentalsRes?.ok) {
      setRentals(((await rentalsRes.json()) as { rentals: RentalListItem[] }).rentals);
    }
    if (catalogRes?.ok) setCatalog((await catalogRes.json()) as Catalog);
  }, [statusFilter]);

  useEffect(() => {
    void refresh();
  }, [refresh]);
  useEvents({ onRentalUpdated: () => void refresh() });

  async function transition(id: string, action: string) {
    setBusy(id);
    setError(null);
    const res = await fetch(`/api/inventory/rentals/${id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action }),
    }).catch(() => null);
    setBusy(null);
    if (!res?.ok) {
      const data = await res?.json().catch(() => null);
      setError(
        (data as { error?: { message?: string } })?.error?.message ?? "La acción falló"
      );
      return;
    }
    await refresh();
  }

  if (!rentals || !catalog) {
    return <p className="text-sm text-muted-foreground">Cargando…</p>;
  }

  return (
    <div className="mx-auto max-w-5xl space-y-6">
      {error && <p className="text-sm text-destructive">{error}</p>}

      <Timeline catalog={catalog} rentals={rentals} />
      <NewRental catalog={catalog} onSaved={refresh} onError={setError} />

      <div className="flex items-center gap-3">
        <Label htmlFor="filter-status">Ver</Label>
        <select
          id="filter-status"
          className={cn(SELECT_CLS, "w-auto")}
          value={statusFilter}
          onChange={(e) => setStatusFilter(e.target.value)}
        >
          <option value="activas">Activas (tentativa + confirmada + en curso)</option>
          <option value="tentativa">Tentativas</option>
          <option value="confirmada">Confirmadas</option>
          <option value="en_curso">En curso</option>
          <option value="finalizada">Finalizadas</option>
          <option value="cancelada">Canceladas</option>
          <option value="todas">Todas</option>
        </select>
      </div>

      <ul className="divide-y rounded-md border">
        {rentals.map((r) => (
          <li key={r.id} className="space-y-2 p-3">
            <div className="flex flex-wrap items-center gap-2">
              <span className="font-mono text-sm font-semibold">{r.unit.internalCode}</span>
              <span className="text-sm">{r.model.name}</span>
              <Badge variant={STATUS_BADGE[r.status]}>{r.status}</Badge>
              {r.kind === "mantenimiento" && <Badge variant="secondary">mantenimiento</Badge>}
              {r.createdBy === "agente" && <Badge variant="outline">creada por el agente</Badge>}
              {r.isTest && <Badge variant="outline">prueba</Badge>}
              <span className="flex-1" />
              <span className="text-sm text-text-2">
                {fmtDate(r.from)} → {fmtDate(r.to)}
              </span>
            </div>
            <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-sm text-text-3">
              {r.contact && <span>{r.contact.name ?? "Contacto sin nombre"}</span>}
              {r.siteLocation && <span>{r.siteLocation}</span>}
              {r.quotedAmountCents !== null && (
                <span>{formatMoneyCents(r.quotedAmountCents, "ARS", "es-AR")}</span>
              )}
              {r.status === "tentativa" && r.expiresAt && (
                <span className="text-warning-text">
                  Expira {new Date(r.expiresAt).toLocaleString("es-AR", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })}
                </span>
              )}
              {r.notes && <span>{r.notes}</span>}
            </div>
            <div className="flex flex-wrap gap-2">
              {r.status === "tentativa" && (
                <Button size="sm" disabled={busy === r.id} onClick={() => void transition(r.id, "confirmar")}>
                  Confirmar
                </Button>
              )}
              {r.status === "confirmada" && (
                <Button size="sm" variant="secondary" disabled={busy === r.id} onClick={() => void transition(r.id, "iniciar")}>
                  Salió a obra
                </Button>
              )}
              {r.status === "en_curso" && (
                <Button size="sm" variant="secondary" disabled={busy === r.id} onClick={() => void transition(r.id, "finalizar")}>
                  Finalizar
                </Button>
              )}
              {["tentativa", "confirmada", "en_curso"].includes(r.status) && (
                <Button size="sm" variant="destructive" disabled={busy === r.id} onClick={() => void transition(r.id, "cancelar")}>
                  Cancelar
                </Button>
              )}
            </div>
          </li>
        ))}
        {rentals.length === 0 && (
          <li className="p-6 text-center text-sm text-muted-foreground">
            No hay reservas con ese filtro.
          </li>
        )}
      </ul>
    </div>
  );
}

/**
 * Ocupación de los próximos 28 días, una fila por unidad. Barras por
 * porcentaje del ancho — suficiente para ver huecos de un vistazo.
 */
function Timeline({ catalog, rentals }: { catalog: Catalog; rentals: RentalListItem[] }) {
  const start = useMemo(() => {
    const d = new Date();
    d.setHours(0, 0, 0, 0);
    return d.getTime();
  }, []);
  const end = start + WINDOW_DAYS * DAY_MS;

  const units = catalog.models.flatMap((m) =>
    m.units
      .filter((u) => u.status !== "baja")
      .map((u) => ({ ...u, modelName: m.name }))
  );

  const active = rentals.filter(
    (r) =>
      ["tentativa", "confirmada", "en_curso"].includes(r.status) &&
      Date.parse(r.to) > start &&
      Date.parse(r.from) < end
  );

  const monthMarks = useMemo(() => {
    const marks: { pct: number; label: string }[] = [];
    for (let d = 0; d < WINDOW_DAYS; d += 7) {
      marks.push({
        pct: (d / WINDOW_DAYS) * 100,
        label: new Date(start + d * DAY_MS).toLocaleDateString("es-AR", {
          day: "numeric",
          month: "short",
        }),
      });
    }
    return marks;
  }, [start]);

  return (
    <Card>
      <CardHeader>
        <CardTitle>Ocupación — próximas 4 semanas</CardTitle>
        <CardDescription>
          Tentativas en amarillo, confirmadas en verde, en curso en verde pleno, mantenimiento en gris.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <div className="relative mb-1 h-4 text-[10px] text-text-3">
          {monthMarks.map((m) => (
            <span key={m.pct} className="absolute" style={{ left: `${m.pct}%` }}>
              {m.label}
            </span>
          ))}
        </div>
        <div className="space-y-1.5">
          {units.map((u) => {
            const bars = active
              .filter((r) => r.unit.id === u.id)
              .map((r) => {
                const from = Math.max(Date.parse(r.from), start);
                const to = Math.min(Date.parse(r.to), end);
                return {
                  id: r.id,
                  left: ((from - start) / (end - start)) * 100,
                  width: Math.max(((to - from) / (end - start)) * 100, 1.5),
                  cls: r.kind === "mantenimiento" ? BAR_CLS.mantenimiento : BAR_CLS[r.status],
                  title: `${r.model.name} · ${r.status} · ${fmtDate(r.from)} → ${fmtDate(r.to)}`,
                };
              });
            return (
              <div key={u.id} className="flex items-center gap-2">
                <span className="w-24 shrink-0 truncate font-mono text-xs" title={u.modelName}>
                  {u.internalCode}
                </span>
                <div className="relative h-5 flex-1 overflow-hidden rounded-sm bg-subtle">
                  {u.status === "mantenimiento" && (
                    <div className="absolute inset-0 bg-warning-tint" title="Unidad en mantenimiento" />
                  )}
                  {bars.map((b) => (
                    <div
                      key={b.id}
                      title={b.title}
                      className={cn("absolute inset-y-0 rounded-sm", b.cls)}
                      style={{ left: `${b.left}%`, width: `${b.width}%` }}
                    />
                  ))}
                </div>
              </div>
            );
          })}
          {units.length === 0 && (
            <p className="text-sm text-muted-foreground">Sin unidades operativas.</p>
          )}
        </div>
      </CardContent>
    </Card>
  );
}

function NewRental({
  catalog,
  onSaved,
  onError,
}: {
  catalog: Catalog;
  onSaved: () => Promise<void> | void;
  onError: (msg: string | null) => void;
}) {
  const [open, setOpen] = useState(false);
  const [unitId, setUnitId] = useState("");
  const [kind, setKind] = useState<"alquiler" | "mantenimiento">("alquiler");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [notes, setNotes] = useState("");
  const [saving, setSaving] = useState(false);

  const units = catalog.models.flatMap((m) =>
    m.units.filter((u) => u.status !== "baja").map((u) => ({ ...u, modelName: m.name }))
  );

  async function save() {
    setSaving(true);
    onError(null);
    const res = await fetch("/api/inventory/rentals", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        unitId,
        kind,
        from: new Date(`${from}T00:00:00`).toISOString(),
        to: new Date(`${to}T00:00:00`).toISOString(),
        notes: notes.trim() || undefined,
      }),
    }).catch(() => null);
    setSaving(false);
    if (!res?.ok) {
      const data = await res?.json().catch(() => null);
      onError(
        (data as { error?: { message?: string } })?.error?.message ??
          "No se pudo crear la reserva"
      );
      return;
    }
    setOpen(false);
    setFrom("");
    setTo("");
    setNotes("");
    await onSaved();
  }

  if (!open) {
    return (
      <Button variant="outline" onClick={() => setOpen(true)}>
        Nueva reserva manual / bloqueo de mantenimiento
      </Button>
    );
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Reserva manual</CardTitle>
        <CardDescription>
          Nace confirmada (la crea un humano). Un bloqueo de mantenimiento ocupa flota igual que un alquiler.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid gap-4 md:grid-cols-4">
          <div className="space-y-1.5">
            <Label htmlFor="nr-unit">Unidad</Label>
            <select id="nr-unit" className={SELECT_CLS} value={unitId} onChange={(e) => setUnitId(e.target.value)}>
              <option value="">Elegí…</option>
              {units.map((u) => (
                <option key={u.id} value={u.id}>
                  {u.internalCode} — {u.modelName}
                </option>
              ))}
            </select>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="nr-kind">Tipo</Label>
            <select
              id="nr-kind"
              className={SELECT_CLS}
              value={kind}
              onChange={(e) => setKind(e.target.value as "alquiler" | "mantenimiento")}
            >
              <option value="alquiler">Alquiler</option>
              <option value="mantenimiento">Bloqueo por mantenimiento</option>
            </select>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="nr-from">Desde</Label>
            <Input id="nr-from" type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="nr-to">Hasta (día de devolución)</Label>
            <Input id="nr-to" type="date" value={to} onChange={(e) => setTo(e.target.value)} />
          </div>
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="nr-notes">Notas</Label>
          <Input id="nr-notes" value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Obra, contacto, motivo del service…" />
        </div>
        <div className="flex gap-2">
          <Button disabled={saving || !unitId || !from || !to} onClick={() => void save()}>
            {saving ? "Guardando…" : "Crear"}
          </Button>
          <Button variant="ghost" onClick={() => setOpen(false)}>
            Cancelar
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

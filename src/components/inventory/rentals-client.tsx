"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";
import type { Catalog, RentalListItem } from "@/server/inventory/queries";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { formatMoneyCents } from "@/lib/money";
import {
  ACTIVOS,
  DAY_MS,
  WINDOW_DAYS,
  busyDaysByUnit,
  startOfToday,
  todayView,
  type Pending,
  type PendingReason,
} from "@/lib/inventory-view";
import { cn } from "@/lib/utils";
import { useEvents } from "@/components/use-events";

/**
 * 017 — La pantalla que el dueño mira todos los días.
 *
 * Rediseñada: antes abría con un renglón por unidad —46 filas casi vacías,
 * donde el único dato real competía contra 45 renglones sin nada, y que
 * empeora a medida que crece la flota. Ahora abre por lo que hay que DECIDIR
 * hoy, sigue con la disponibilidad por MODELO (que es como pregunta el
 * cliente: "¿tenés una retro libre?", no "¿está libre la RETRO-03?") y deja
 * el detalle por unidad plegado, para cuando hace falta la chapa exacta.
 *
 * Las transiciones siguen siendo HUMANAS: el agente solo llega a "tentativa".
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

function fmtDate(iso: string): string {
  return new Date(iso).toLocaleDateString("es-AR", { day: "numeric", month: "short" });
}

/** Cómo se le explica al dueño por qué una reserva está en la lista de hoy. */
function motivo(p: Pending): string {
  const dict: Record<PendingReason, string> = {
    vence: p.rental.expiresAt
      ? `se cae sola ${new Date(p.rental.expiresAt).toLocaleTimeString("es-AR", { hour: "2-digit", minute: "2-digit" })}`
      : "tentativa por vencer",
    atrasada: `tenía que salir el ${fmtDate(p.rental.from)}`,
    sale_hoy: "sale hoy",
    vuelve_hoy: "vuelve hoy",
  };
  return dict[p.reason];
}

export function RentalsClient() {
  // Dos juegos de datos a propósito: el de arriba (hoy + disponibilidad)
  // siempre mira las reservas ACTIVAS, pase lo que pase con el filtro de la
  // lista de abajo. Si el dueño filtra por "canceladas", la operación del día
  // no puede vaciarse.
  const [activas, setActivas] = useState<RentalListItem[] | null>(null);
  const [rentals, setRentals] = useState<RentalListItem[] | null>(null);
  const [catalog, setCatalog] = useState<Catalog | null>(null);
  const [statusFilter, setStatusFilter] = useState<string>("activas");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    const activasQuery = "?status=tentativa&status=confirmada&status=en_curso";
    const query =
      statusFilter === "activas"
        ? activasQuery
        : statusFilter === "todas"
          ? ""
          : `?status=${statusFilter}`;
    const pedidos: Promise<Response | null>[] = [
      fetch(`/api/inventory/rentals${query}`).catch(() => null),
      fetch("/api/inventory/catalog").catch(() => null),
    ];
    // Con el filtro por defecto, la lista YA son las activas: no se pide dos veces.
    if (query !== activasQuery) {
      pedidos.push(fetch(`/api/inventory/rentals${activasQuery}`).catch(() => null));
    }
    const [rentalsRes, catalogRes, activasRes] = await Promise.all(pedidos);

    let lista: RentalListItem[] | null = null;
    if (rentalsRes?.ok) {
      lista = ((await rentalsRes.json()) as { rentals: RentalListItem[] }).rentals;
      setRentals(lista);
    }
    if (catalogRes?.ok) setCatalog((await catalogRes.json()) as Catalog);
    if (activasRes?.ok) {
      setActivas(((await activasRes.json()) as { rentals: RentalListItem[] }).rentals);
    } else if (query === activasQuery && lista) {
      setActivas(lista);
    }
  }, [statusFilter]);

  useEffect(() => {
    void refresh();
  }, [refresh]);
  useEvents({ onRentalUpdated: () => void refresh() });

  const transition = useCallback(
    async (id: string, action: string) => {
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
    },
    [refresh]
  );

  if (!rentals || !catalog || !activas) {
    return <p className="text-sm text-muted-foreground">Cargando…</p>;
  }

  return (
    <div className="mx-auto max-w-5xl space-y-6">
      {error && <p className="text-sm text-destructive">{error}</p>}

      <Hoy rentals={activas} busy={busy} onAction={transition} />
      <Disponibilidad catalog={catalog} rentals={activas} />
      <PorUnidad catalog={catalog} rentals={activas} />
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
              {r.hoursPerDay !== null && <span>{r.hoursPerDay} hs/día</span>}
              {r.quotedAmountCents !== null && (
                <span>
                  {formatMoneyCents(r.quotedAmountCents, "ARS", "es-AR")}
                  <span className="text-text-3"> + IVA</span>
                </span>
              )}
              {r.status === "tentativa" && r.expiresAt && (
                <span className="text-warning-text">
                  Expira {new Date(r.expiresAt).toLocaleString("es-AR", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })}
                </span>
              )}
              {r.notes && <span>{r.notes}</span>}
            </div>
            <Acciones id={r.id} status={r.status} busy={busy} onAction={transition} />
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

/** Los botones de transición, iguales en la lista y en el panel de hoy. */
function Acciones({
  id,
  status,
  busy,
  onAction,
  size = "sm",
}: {
  id: string;
  status: RentalListItem["status"];
  busy: string | null;
  onAction: (id: string, action: string) => void | Promise<void>;
  size?: "sm";
}) {
  return (
    <div className="flex flex-wrap gap-2">
      {status === "tentativa" && (
        <Button size={size} disabled={busy === id} onClick={() => void onAction(id, "confirmar")}>
          Confirmar
        </Button>
      )}
      {status === "confirmada" && (
        <Button size={size} variant="secondary" disabled={busy === id} onClick={() => void onAction(id, "iniciar")}>
          Salió a obra
        </Button>
      )}
      {status === "en_curso" && (
        <Button size={size} variant="secondary" disabled={busy === id} onClick={() => void onAction(id, "finalizar")}>
          Finalizar
        </Button>
      )}
      {ACTIVOS.includes(status) && (
        <Button size={size} variant="destructive" disabled={busy === id} onClick={() => void onAction(id, "cancelar")}>
          Cancelar
        </Button>
      )}
    </div>
  );
}

/**
 * Lo que hay que decidir HOY, que es con lo que abre la mañana del dueño:
 * qué sale, qué vuelve, qué tentativa se está por caer sola y qué tenía que
 * haber salido y nadie marcó.
 */
function Hoy({
  rentals,
  busy,
  onAction,
}: {
  rentals: RentalListItem[];
  busy: string | null;
  onAction: (id: string, action: string) => void | Promise<void>;
}) {
  const { salen, vuelven, vencen, pendientes } = useMemo(
    () => todayView(rentals),
    [rentals]
  );

  return (
    <Card>
      <CardHeader>
        <CardTitle>Hoy</CardTitle>
        <CardDescription>
          Lo que necesita una decisión tuya. El agente deja tentativas; confirmarlas,
          despacharlas y cerrarlas es de acá.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid gap-3 sm:grid-cols-3">
          <Contador n={salen.length} label="salen hoy" />
          <Contador n={vuelven.length} label={vuelven.length === 1 ? "vuelve hoy" : "vuelven hoy"} />
          <Contador
            n={vencen.length}
            label={vencen.length === 1 ? "tentativa por vencer" : "tentativas por vencer"}
            alerta={vencen.length > 0}
          />
        </div>

        {pendientes.length === 0 ? (
          <p className="rounded-md bg-subtle p-4 text-center text-sm text-text-3">
            Nada pendiente para hoy.
          </p>
        ) : (
          <ul className="divide-y rounded-md border">
            {pendientes.map((p) => (
              <li
                key={`${p.rental.id}-${p.reason}`}
                className="flex flex-wrap items-center gap-x-3 gap-y-2 p-3 text-sm"
              >
                <span className="font-mono text-xs font-semibold">
                  {p.rental.unit.internalCode}
                </span>
                <span className="min-w-0 flex-1 truncate">
                  {p.rental.model.name}
                  {p.rental.contact?.name && (
                    <span className="text-text-3"> · {p.rental.contact.name}</span>
                  )}
                  {p.rental.siteLocation && (
                    <span className="text-text-3"> · {p.rental.siteLocation}</span>
                  )}
                </span>
                <span className={cn("text-xs", p.urgent ? "text-warning-text" : "text-text-3")}>
                  {motivo(p)}
                </span>
                <Acciones
                  id={p.rental.id}
                  status={p.rental.status}
                  busy={busy}
                  onAction={onAction}
                />
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}

function Contador({ n, label, alerta }: { n: number; label: string; alerta?: boolean }) {
  return (
    <div
      className={cn(
        "rounded-md border p-3",
        alerta ? "border-warning bg-warning-tint" : "bg-subtle"
      )}
    >
      <p className={cn("text-2xl font-semibold leading-none", alerta && "text-warning-text")}>
        {n}
      </p>
      <p className={cn("mt-1 text-xs", alerta ? "text-warning-text" : "text-text-3")}>{label}</p>
    </div>
  );
}

/**
 * Cuántas unidades quedan LIBRES de cada modelo, día por día.
 *
 * Es la vista que contesta la pregunta que de verdad llega por WhatsApp
 * ("¿tenés una retro del 12 al 15?"): al cliente no le importa qué chapa le
 * toca. Por eso las filas son modelos y no unidades — 25 renglones en vez de
 * 46, y cada celda dice un número en vez de obligar a contar barras.
 *
 * Los días en que está todo libre quedan APAGADOS a propósito: si se pintara
 * de verde lo normal, lo excepcional no resaltaría.
 */
function Disponibilidad({ catalog, rentals }: { catalog: Catalog; rentals: RentalListItem[] }) {
  const inicio = useMemo(() => startOfToday(), []);
  const ocupadas = useMemo(
    () => busyDaysByUnit(rentals, catalog, inicio),
    [rentals, catalog, inicio]
  );

  const posicionCat = new Map(catalog.categories.map((c) => [c.id, c.position]));
  const filas = catalog.models
    .map((m) => ({
      id: m.id,
      nombre: m.name,
      categoria: catalog.categories.find((c) => c.id === m.categoryId)?.name ?? "",
      orden: posicionCat.get(m.categoryId) ?? 99,
      unidades: m.units.filter((u) => u.status !== "baja"),
    }))
    .filter((f) => f.unidades.length > 0)
    .sort((a, b) => a.orden - b.orden || a.nombre.localeCompare(b.nombre));

  const dias = Array.from({ length: WINDOW_DAYS }, (_, i) => new Date(inicio + i * DAY_MS));

  return (
    <Card>
      <CardHeader>
        <CardTitle>Disponibilidad por modelo — próximas 4 semanas</CardTitle>
        <CardDescription>
          El número es cuántas unidades quedan libres ese día. En blanco = está todo libre.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <div className="overflow-x-auto">
          <div className="min-w-[640px]">
            <div className="mb-1 flex items-center gap-2">
              <span className="w-40 shrink-0" />
              <div
                className="grid flex-1 gap-px"
                style={{ gridTemplateColumns: `repeat(${WINDOW_DAYS}, minmax(0, 1fr))` }}
              >
                {dias.map((d, i) => (
                  <span key={i} className="text-center text-[9px] leading-4 text-text-3">
                    {i === 0 ? "hoy" : i % 7 === 0 ? d.getDate() : ""}
                  </span>
                ))}
              </div>
            </div>

            <div className="space-y-px">
              {filas.map((f) => {
                const total = f.unidades.length;
                return (
                  <div key={f.id} className="flex items-center gap-2">
                    <span
                      className="w-40 shrink-0 truncate text-xs text-text-2"
                      title={`${f.nombre} — ${f.categoria} · ${total} ${total === 1 ? "unidad" : "unidades"}`}
                    >
                      {f.nombre}
                    </span>
                    <div
                      className="grid flex-1 gap-px"
                      style={{ gridTemplateColumns: `repeat(${WINDOW_DAYS}, minmax(0, 1fr))` }}
                    >
                      {dias.map((d, i) => {
                        const libres = f.unidades.filter(
                          (u) => !ocupadas.get(u.id)?.has(i)
                        ).length;
                        const cls =
                          libres === 0
                            ? "bg-danger-soft text-danger-text"
                            : libres < total
                              ? "bg-warning-soft text-warning-text"
                              : "bg-subtle text-text-3";
                        return (
                          <div
                            key={i}
                            title={`${f.nombre} · ${d.toLocaleDateString("es-AR", { day: "numeric", month: "short" })} · ${libres} de ${total} ${libres === 1 ? "libre" : "libres"}`}
                            className={cn(
                              "flex h-5 items-center justify-center rounded-[2px] text-[9px] tabular-nums",
                              cls
                            )}
                          >
                            {libres < total ? libres : ""}
                          </div>
                        );
                      })}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        </div>
        <p className="mt-3 text-xs text-text-3">
          Amarillo: queda flota pero no toda. Rojo: no queda ninguna libre ese día.
        </p>
      </CardContent>
    </Card>
  );
}

/**
 * El detalle por unidad, que sigue haciendo falta cuando algo se complica y
 * hay que ver la chapa exacta. Plegado por categoría: 11 renglones en vez de
 * 46, y se abre solo el que interesa.
 */
function PorUnidad({ catalog, rentals }: { catalog: Catalog; rentals: RentalListItem[] }) {
  const [abiertas, setAbiertas] = useState<Set<string>>(new Set());
  const inicio = useMemo(() => startOfToday(), []);
  const fin = inicio + WINDOW_DAYS * DAY_MS;
  const ocupadas = useMemo(
    () => busyDaysByUnit(rentals, catalog, inicio),
    [rentals, catalog, inicio]
  );

  const grupos = catalog.categories
    .map((c) => {
      const unidades = catalog.models
        .filter((m) => m.categoryId === c.id)
        .flatMap((m) =>
          m.units
            .filter((u) => u.status !== "baja")
            .map((u) => ({ ...u, modelName: m.name }))
        );
      const ocupadasHoy = unidades.filter((u) => ocupadas.get(u.id)?.has(0)).length;
      return { ...c, unidades, ocupadasHoy };
    })
    .filter((g) => g.unidades.length > 0);

  const activos = rentals.filter(
    (r) =>
      ACTIVOS.includes(r.status) &&
      Date.parse(r.to) > inicio &&
      Date.parse(r.from) < fin
  );

  return (
    <Card>
      <CardHeader>
        <CardTitle>Ocupación por unidad</CardTitle>
        <CardDescription>
          Tentativas en amarillo, confirmadas en verde, en curso en verde pleno,
          mantenimiento en gris. Abrí la categoría que te interese.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-1">
        {grupos.map((g) => {
          const abierta = abiertas.has(g.id);
          return (
            <div key={g.id} className="rounded-md border">
              <button
                type="button"
                aria-expanded={abierta}
                className="flex w-full items-center gap-2 p-2.5 text-left text-sm hover:bg-accent"
                onClick={() =>
                  setAbiertas((prev) => {
                    const next = new Set(prev);
                    if (!next.delete(g.id)) next.add(g.id);
                    return next;
                  })
                }
              >
                {abierta ? (
                  <ChevronDown className="h-4 w-4 shrink-0 text-text-3" />
                ) : (
                  <ChevronRight className="h-4 w-4 shrink-0 text-text-3" />
                )}
                <span className="flex-1 font-medium">{g.name}</span>
                <span className="text-xs text-text-3">
                  {g.ocupadasHoy} de {g.unidades.length} ocupadas hoy
                </span>
                <span className="flex shrink-0 gap-px" aria-hidden>
                  {g.unidades.map((u) => (
                    <span
                      key={u.id}
                      className={cn(
                        "h-3 w-1.5 rounded-[1px]",
                        ocupadas.get(u.id)?.has(0) ? "bg-brand-soft" : "bg-subtle"
                      )}
                    />
                  ))}
                </span>
              </button>

              {abierta && (
                <div className="space-y-1.5 border-t p-2.5">
                  {g.unidades.map((u) => {
                    const bars = activos
                      .filter((r) => r.unit.id === u.id)
                      .map((r) => {
                        const from = Math.max(Date.parse(r.from), inicio);
                        const to = Math.min(Date.parse(r.to), fin);
                        return {
                          id: r.id,
                          left: ((from - inicio) / (fin - inicio)) * 100,
                          width: Math.max(((to - from) / (fin - inicio)) * 100, 1.5),
                          cls:
                            r.kind === "mantenimiento"
                              ? BAR_CLS.mantenimiento
                              : BAR_CLS[r.status],
                          title: `${r.model.name} · ${r.status} · ${fmtDate(r.from)} → ${fmtDate(r.to)}`,
                        };
                      });
                    return (
                      <div key={u.id} className="flex items-center gap-2">
                        <span
                          className="w-24 shrink-0 truncate font-mono text-xs"
                          title={u.modelName}
                        >
                          {u.internalCode}
                        </span>
                        <div className="relative h-5 flex-1 overflow-hidden rounded-sm bg-subtle">
                          {u.status === "mantenimiento" && (
                            <div
                              className="absolute inset-0 bg-warning-tint"
                              title="Unidad en mantenimiento"
                            />
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
                </div>
              )}
            </div>
          );
        })}
        {grupos.length === 0 && (
          <p className="text-sm text-muted-foreground">Sin unidades operativas.</p>
        )}
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

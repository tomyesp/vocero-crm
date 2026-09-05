"use client";

import { useCallback, useEffect, useState } from "react";
import type { Catalog } from "@/server/inventory/queries";
import type { QuoteBreakdown } from "@/server/inventory/quote";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { formatMoneyCents, parseMoneyToCents } from "@/lib/money";

/**
 * 017 — Tarifas con vigencia temporal + simulador de cotización.
 * El simulador llama /api/inventory/quote, que usa EXACTAMENTE la misma
 * función que el endpoint del bot: lo que se ve acá es lo que dice el agente.
 *
 * Una tarifa de RPM es UN número: el precio de la hora de máquina, con
 * operario y combustible adentro y sin IVA. Lo único que se carga aparte es
 * el traslado.
 */

const SELECT_CLS =
  "flex h-9 w-full rounded-md border border-input bg-card px-3 text-sm";
const ARS = "ARS";

type RateRow = {
  id: string;
  hourlyCents: number;
  minHours: number;
  transferBaseCents: number;
  transferPerKmCents: number;
  validFrom: string;
  validTo: string | null;
};

function money(cents: number | null | undefined): string {
  return formatMoneyCents(cents ?? null, ARS, "es-AR") ?? "—";
}

/** 8, no "8.0"; 4,5 con coma, que es como se escribe media jornada acá. */
function hours(h: number): string {
  return Number.isInteger(h) ? String(h) : String(h).replace(".", ",");
}

export function RatesClient() {
  const [catalog, setCatalog] = useState<Catalog | null>(null);
  const [modelId, setModelId] = useState("");
  const [history, setHistory] = useState<RateRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refreshCatalog = useCallback(async () => {
    const res = await fetch("/api/inventory/catalog").catch(() => null);
    if (!res?.ok) return;
    const data = (await res.json()) as Catalog;
    setCatalog(data);
    setModelId((prev) => prev || (data.models[0]?.id ?? ""));
  }, []);

  const refreshHistory = useCallback(async () => {
    if (!modelId) return;
    const res = await fetch(`/api/inventory/rates?modelId=${modelId}`).catch(() => null);
    if (!res?.ok) return;
    const data = (await res.json()) as { rates: RateRow[] };
    setHistory(data.rates);
  }, [modelId]);

  useEffect(() => {
    void refreshCatalog();
  }, [refreshCatalog]);
  useEffect(() => {
    void refreshHistory();
  }, [refreshHistory]);

  if (!catalog) return <p className="text-sm text-muted-foreground">Cargando…</p>;
  const model = catalog.models.find((m) => m.id === modelId) ?? null;

  return (
    <div className="mx-auto max-w-4xl space-y-6">
      {error && <p className="text-sm text-destructive">{error}</p>}

      <div className="max-w-sm space-y-1.5">
        <Label htmlFor="rate-model">Modelo</Label>
        <select
          id="rate-model"
          className={SELECT_CLS}
          value={modelId}
          onChange={(e) => setModelId(e.target.value)}
        >
          {catalog.models.map((m) => (
            <option key={m.id} value={m.id}>
              {m.name}
            </option>
          ))}
        </select>
      </div>

      {model && (
        <>
          <NewRate
            modelId={model.id}
            current={history?.find((r) => r.validTo === null) ?? null}
            onSaved={() => {
              void refreshHistory();
              void refreshCatalog();
            }}
            onError={setError}
          />
          <Simulator modelId={model.id} />
          <Card>
            <CardHeader>
              <CardTitle>Histórico</CardTitle>
              <CardDescription>
                Nunca se sobrescribe una tarifa: cada cambio cierra la vigente y crea una fila nueva.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <ul className="divide-y rounded-md border">
                {(history ?? []).map((r) => (
                  <li key={r.id} className="flex flex-wrap items-center gap-x-4 gap-y-1 p-3 text-sm">
                    <span className={r.validTo === null ? "font-semibold" : "text-text-3"}>
                      {new Date(r.validFrom).toLocaleDateString("es-AR")}
                      {" → "}
                      {r.validTo ? new Date(r.validTo).toLocaleDateString("es-AR") : "vigente"}
                    </span>
                    <span>Hora: {money(r.hourlyCents)}</span>
                    <span className="text-text-3">
                      {r.minHours > 0 ? `Mínimo ${hours(r.minHours)} hs · ` : "Sin mínimo · "}
                      Traslado {money(r.transferBaseCents)} + {money(r.transferPerKmCents)}/km
                    </span>
                  </li>
                ))}
                {(history ?? []).length === 0 && (
                  <li className="p-3 text-sm text-muted-foreground">
                    Sin tarifas: el bot no puede cotizar este modelo hasta que cargues una.
                  </li>
                )}
              </ul>
            </CardContent>
          </Card>
        </>
      )}
    </div>
  );
}

function MoneyField({
  id,
  label,
  value,
  onChange,
}: {
  id: string;
  label: string;
  value: string;
  onChange: (v: string) => void;
}) {
  return (
    <div className="space-y-1.5">
      <Label htmlFor={id}>{label}</Label>
      <Input id={id} value={value} onChange={(e) => onChange(e.target.value)} placeholder="$ 0" />
    </div>
  );
}

function NewRate({
  modelId,
  current,
  onSaved,
  onError,
}: {
  modelId: string;
  current: RateRow | null;
  onSaved: () => void;
  onError: (msg: string | null) => void;
}) {
  const [hourly, setHourly] = useState("");
  const [minHours, setMinHours] = useState("");
  const [transferBase, setTransferBase] = useState("");
  const [transferKm, setTransferKm] = useState("");
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  // Precargar con la vigente: lo normal es ajustar, no arrancar de cero.
  useEffect(() => {
    const toInput = (c: number | null) => (c === null || c === 0 ? "" : String(c / 100));
    setHourly(current ? String(current.hourlyCents / 100) : "");
    setMinHours(current && current.minHours > 0 ? String(current.minHours) : "");
    setTransferBase(toInput(current?.transferBaseCents ?? null));
    setTransferKm(toInput(current?.transferPerKmCents ?? null));
  }, [current, modelId]);

  const hourlyCents = parseMoneyToCents(hourly);
  const minHoursNum = minHours.trim() === "" ? 0 : Number(minHours.replace(",", "."));
  const minHoursOk = Number.isFinite(minHoursNum) && minHoursNum >= 0 && minHoursNum <= 24;

  async function save() {
    if (hourlyCents === null || !minHoursOk) return;
    setSaving(true);
    setSaved(false);
    onError(null);
    const res = await fetch("/api/inventory/rates", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        modelId,
        hourlyCents,
        minHours: minHoursNum,
        transferBaseCents: parseMoneyToCents(transferBase) ?? 0,
        transferPerKmCents: parseMoneyToCents(transferKm) ?? 0,
      }),
    }).catch(() => null);
    setSaving(false);
    if (!res?.ok) {
      onError("No se pudo guardar la tarifa");
      return;
    }
    setSaved(true);
    onSaved();
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Tarifa nueva</CardTitle>
        <CardDescription>
          El precio de la HORA de máquina, en pesos y <strong>sin IVA</strong> — con operario y
          combustible incluidos, que es como está el catálogo. El traslado se cobra aparte.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid gap-4 md:grid-cols-2">
          <MoneyField id="r-h" label="Por hora" value={hourly} onChange={setHourly} />
          <div className="space-y-1.5">
            <Label htmlFor="r-min">Mínimo de horas</Label>
            <Input
              id="r-min"
              value={minHours}
              onChange={(e) => setMinHours(e.target.value)}
              placeholder="sin mínimo"
            />
          </div>
          <MoneyField id="r-tb" label="Traslado base" value={transferBase} onChange={setTransferBase} />
          <MoneyField id="r-tk" label="Traslado por km" value={transferKm} onChange={setTransferKm} />
        </div>
        <div className="flex items-center gap-3">
          <Button
            disabled={saving || hourlyCents === null || !minHoursOk}
            onClick={() => void save()}
          >
            {saving ? "Guardando…" : "Guardar tarifa nueva"}
          </Button>
          {saved && <span className="text-sm text-brand-text">Guardado</span>}
          {!minHoursOk && (
            <span className="text-sm text-destructive">El mínimo va entre 0 y 24 horas</span>
          )}
        </div>
      </CardContent>
    </Card>
  );
}

function Simulator({ modelId }: { modelId: string }) {
  const [days, setDays] = useState("1");
  const [hoursPerDay, setHoursPerDay] = useState("8");
  const [withTransfer, setWithTransfer] = useState(false);
  const [km, setKm] = useState("0");
  const [quote, setQuote] = useState<QuoteBreakdown | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const hoursNum = Number(hoursPerDay.replace(",", "."));
  const canRun = Number(days) >= 1 && hoursNum > 0 && hoursNum <= 24;

  async function run() {
    setBusy(true);
    setError(null);
    setQuote(null);
    const res = await fetch("/api/inventory/quote", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        modelId,
        days: Number(days),
        hoursPerDay: hoursNum,
        withTransfer,
        km: Number(km) || 0,
      }),
    }).catch(() => null);
    setBusy(false);
    if (!res?.ok) {
      const data = await res?.json().catch(() => null);
      setError(
        (data as { error?: { message?: string } })?.error?.message ??
          "No se pudo cotizar"
      );
      return;
    }
    setQuote(((await res.json()) as { quote: QuoteBreakdown }).quote);
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Simulador de cotización</CardTitle>
        <CardDescription>
          El mismo cálculo que usa el agente por WhatsApp — números idénticos.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex flex-wrap items-end gap-4">
          <div className="w-24 space-y-1.5">
            <Label htmlFor="sim-days">Días</Label>
            <Input
              id="sim-days"
              type="number"
              min={1}
              value={days}
              onChange={(e) => setDays(e.target.value)}
            />
          </div>
          <div className="w-28 space-y-1.5">
            <Label htmlFor="sim-hours">Horas por día</Label>
            <Input
              id="sim-hours"
              value={hoursPerDay}
              onChange={(e) => setHoursPerDay(e.target.value)}
            />
          </div>
          <label className="flex h-9 items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={withTransfer}
              onChange={(e) => setWithTransfer(e.target.checked)}
            />
            Con traslado
          </label>
          {withTransfer && (
            <div className="w-24 space-y-1.5">
              <Label htmlFor="sim-km">Km</Label>
              <Input
                id="sim-km"
                type="number"
                min={0}
                value={km}
                onChange={(e) => setKm(e.target.value)}
              />
            </div>
          )}
          <Button variant="secondary" disabled={busy || !canRun} onClick={() => void run()}>
            {busy ? "Cotizando…" : "Cotizar"}
          </Button>
        </div>
        {error && <p className="text-sm text-destructive">{error}</p>}
        {quote && (
          <div className="rounded-sm bg-subtle p-3 text-sm">
            <p>
              {quote.days} {quote.days === 1 ? "día" : "días"} × {hours(quote.hoursPerDay)} hs ={" "}
              {hours(quote.requestedHours)} hs × {money(quote.hourlyCents)}/h
            </p>
            {quote.billedHours !== quote.requestedHours && (
              <p className="text-text-3">
                Se facturan {hours(quote.billedHours)} hs por el mínimo de{" "}
                {hours(quote.minHours)} hs.
              </p>
            )}
            <p>Máquina (con operario y combustible): {money(quote.machineCents)}</p>
            {quote.transferCents > 0 && <p>Traslado: {money(quote.transferCents)}</p>}
            <p className="font-semibold">Total: {money(quote.totalCents)} + IVA</p>
            <p className="text-text-3">
              El agente dice este número tal cual, aclarando que no incluye IVA.
            </p>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

"use client";

import { useCallback, useEffect, useState } from "react";
import { ChevronDown, ChevronRight, Plus, Trash2, Upload } from "lucide-react";
import type { Catalog, CatalogModel } from "@/server/inventory/queries";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";

/**
 * 017 — CRUD del catálogo: categorías, modelos, unidades y fotos.
 * Todo por fetch contra /api/inventory/*, con feedback inline (sin toasts,
 * como el resto del repo).
 */

const SELECT_CLS =
  "flex h-9 w-full rounded-md border border-input bg-card px-3 text-sm";

const UNIT_STATUS_BADGE: Record<string, "success" | "warning" | "secondary"> = {
  operativa: "success",
  mantenimiento: "warning",
  baja: "secondary",
};

export function MachinesClient() {
  const [catalog, setCatalog] = useState<Catalog | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    const res = await fetch("/api/inventory/catalog").catch(() => null);
    if (!res?.ok) {
      setError("No se pudo cargar el catálogo");
      return;
    }
    setCatalog((await res.json()) as Catalog);
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  async function api(
    url: string,
    method: string,
    body?: unknown
  ): Promise<boolean> {
    setBusy(true);
    setError(null);
    const res = await fetch(url, {
      method,
      ...(body !== undefined
        ? {
            headers: { "content-type": "application/json" },
            body: JSON.stringify(body),
          }
        : {}),
    }).catch(() => null);
    setBusy(false);
    if (!res?.ok) {
      const data = await res?.json().catch(() => null);
      setError(
        (data as { error?: { message?: string } })?.error?.message ??
          "La operación falló"
      );
      return false;
    }
    await refresh();
    return true;
  }

  if (!catalog) {
    return <p className="text-sm text-muted-foreground">Cargando…</p>;
  }

  return (
    <div className="mx-auto max-w-4xl space-y-6">
      {error && <p className="text-sm text-destructive">{error}</p>}
      <Categories catalog={catalog} busy={busy} api={api} />
      <NewModel catalog={catalog} busy={busy} api={api} />
      <div className="space-y-3">
        {catalog.models.map((m) => (
          <ModelCard key={m.id} model={m} catalog={catalog} busy={busy} api={api} />
        ))}
        {catalog.models.length === 0 && (
          <div className="rounded-lg border border-dashed p-6 text-center text-sm text-muted-foreground">
            Sin modelos todavía: cargá el primero arriba.
          </div>
        )}
      </div>
    </div>
  );
}

type Api = (url: string, method: string, body?: unknown) => Promise<boolean>;

function Categories({
  catalog,
  busy,
  api,
}: {
  catalog: Catalog;
  busy: boolean;
  api: Api;
}) {
  const [name, setName] = useState("");
  return (
    <Card>
      <CardHeader>
        <CardTitle>Categorías</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="flex flex-wrap gap-2">
          {catalog.categories.map((c) => (
            <span
              key={c.id}
              className="flex items-center gap-1.5 rounded-md border px-2.5 py-1 text-sm"
            >
              {c.name}
              <button
                aria-label={`Borrar ${c.name}`}
                disabled={busy}
                onClick={() => void api(`/api/inventory/categories/${c.id}`, "DELETE")}
                className="text-text-3 hover:text-destructive"
              >
                <Trash2 className="h-3.5 w-3.5" />
              </button>
            </span>
          ))}
        </div>
        <form
          className="flex gap-2"
          onSubmit={async (e) => {
            e.preventDefault();
            if (!name.trim()) return;
            if (await api("/api/inventory/categories", "POST", { name: name.trim() })) {
              setName("");
            }
          }}
        >
          <Input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Nueva categoría (ej. Retroexcavadoras)"
            className="max-w-xs"
          />
          <Button type="submit" size="sm" disabled={busy || !name.trim()}>
            <Plus className="mr-1 h-4 w-4" /> Agregar
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}

function NewModel({
  catalog,
  busy,
  api,
}: {
  catalog: Catalog;
  busy: boolean;
  api: Api;
}) {
  const [name, setName] = useState("");
  const [brand, setBrand] = useState("");
  const [categoryId, setCategoryId] = useState("");

  return (
    <Card>
      <CardHeader>
        <CardTitle>Nuevo modelo</CardTitle>
      </CardHeader>
      <CardContent>
        <form
          className="grid gap-4 md:grid-cols-4"
          onSubmit={async (e) => {
            e.preventDefault();
            const ok = await api("/api/inventory/models", "POST", {
              categoryId,
              name: name.trim(),
              brand: brand.trim() || undefined,
            });
            if (ok) {
              setName("");
              setBrand("");
            }
          }}
        >
          <div className="space-y-1.5">
            <Label htmlFor="model-name">Nombre</Label>
            <Input
              id="model-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Retroexcavadora JCB 3CX"
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="model-brand">Marca</Label>
            <Input
              id="model-brand"
              value={brand}
              onChange={(e) => setBrand(e.target.value)}
              placeholder="JCB"
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="model-cat">Categoría</Label>
            <select
              id="model-cat"
              className={SELECT_CLS}
              value={categoryId}
              onChange={(e) => setCategoryId(e.target.value)}
            >
              <option value="">Elegí…</option>
              {catalog.categories.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          </div>
          <div className="flex items-end">
            <Button type="submit" disabled={busy || !name.trim() || !categoryId}>
              Crear modelo
            </Button>
          </div>
        </form>
      </CardContent>
    </Card>
  );
}

function ModelCard({
  model,
  catalog,
  busy,
  api,
}: {
  model: CatalogModel;
  catalog: Catalog;
  busy: boolean;
  api: Api;
}) {
  const [open, setOpen] = useState(false);
  const [description, setDescription] = useState(model.description ?? "");
  const [specsText, setSpecsText] = useState(
    JSON.stringify(model.specs, null, 2)
  );
  const [specsError, setSpecsError] = useState<string | null>(null);
  const [unitCode, setUnitCode] = useState("");
  const [uploading, setUploading] = useState(false);
  const category = catalog.categories.find((c) => c.id === model.categoryId);

  async function saveDetails() {
    let specs: Record<string, unknown> | undefined;
    try {
      const parsed: unknown = JSON.parse(specsText || "{}");
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
        throw new Error("no es objeto");
      }
      specs = parsed as Record<string, unknown>;
      setSpecsError(null);
    } catch {
      setSpecsError("Las specs deben ser un objeto JSON válido");
      return;
    }
    await api(`/api/inventory/models/${model.id}`, "PATCH", {
      description: description.trim() || null,
      specs,
    });
  }

  async function uploadPhoto(file: File) {
    setUploading(true);
    const form = new FormData();
    form.append("file", file);
    const res = await fetch(`/api/inventory/models/${model.id}/photos`, {
      method: "POST",
      body: form,
    }).catch(() => null);
    setUploading(false);
    if (res?.ok) {
      // refetch vía el api() compartido (no-op PATCH sería ruido: refetch directo)
      await api(`/api/inventory/models/${model.id}`, "PATCH", {});
    }
  }

  return (
    <Card className={cn(!model.active && "opacity-60")}>
      <CardHeader className="cursor-pointer" onClick={() => setOpen((v) => !v)}>
        <div className="flex items-center gap-2">
          {open ? (
            <ChevronDown className="h-4 w-4 text-text-3" />
          ) : (
            <ChevronRight className="h-4 w-4 text-text-3" />
          )}
          <CardTitle className="flex-1">
            {model.name}
            {model.brand && (
              <span className="ml-2 text-sm font-normal text-text-3">{model.brand}</span>
            )}
          </CardTitle>
          <span className="text-xs text-text-3">{category?.name}</span>
          {!model.requiresOperator && <Badge variant="warning">Sin operario</Badge>}
          <Badge variant={model.active ? "success" : "secondary"}>
            {model.active ? "Activo" : "Apagado"}
          </Badge>
          <span className="text-xs text-text-3">
            {model.units.length} unidad{model.units.length === 1 ? "" : "es"}
          </span>
        </div>
      </CardHeader>
      {open && (
        <CardContent className="space-y-4">
          <div className="flex flex-wrap gap-2">
            <Button
              size="sm"
              variant="outline"
              disabled={busy}
              onClick={() =>
                void api(`/api/inventory/models/${model.id}`, "PATCH", {
                  active: !model.active,
                })
              }
            >
              {model.active ? "Apagar del catálogo" : "Reactivar"}
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={busy}
              onClick={() =>
                void api(`/api/inventory/models/${model.id}`, "PATCH", {
                  requiresOperator: !model.requiresOperator,
                })
              }
            >
              {model.requiresOperator ? "Marcar sin operario" : "Marcar con operario"}
            </Button>
            <Button
              size="sm"
              variant="destructive"
              disabled={busy}
              onClick={() => void api(`/api/inventory/models/${model.id}`, "DELETE")}
            >
              Borrar modelo
            </Button>
          </div>

          {/* Fotos: storage local vía mediaAsset (sin terceros). */}
          <div className="space-y-1.5">
            <Label>Fotos</Label>
            <div className="flex flex-wrap items-center gap-2">
              {model.photos.map((assetId) => (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  key={assetId}
                  src={`/api/media/${assetId}`}
                  alt={model.name}
                  className="h-20 w-20 rounded-md border object-cover"
                />
              ))}
              <label className="flex h-20 w-20 cursor-pointer items-center justify-center rounded-md border border-dashed text-text-3 hover:bg-accent">
                <Upload className="h-5 w-5" />
                <input
                  type="file"
                  accept="image/jpeg,image/png,image/webp"
                  className="hidden"
                  disabled={uploading}
                  onChange={(e) => {
                    const file = e.target.files?.[0];
                    if (file) void uploadPhoto(file);
                    e.target.value = "";
                  }}
                />
              </label>
            </div>
          </div>

          <div className="grid gap-4 md:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor={`desc-${model.id}`}>Descripción</Label>
              <Textarea
                id={`desc-${model.id}`}
                rows={5}
                value={description}
                onChange={(e) => setDescription(e.target.value)}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor={`specs-${model.id}`}>Specs (JSON)</Label>
              <Textarea
                id={`specs-${model.id}`}
                rows={5}
                className="font-mono text-xs"
                value={specsText}
                onChange={(e) => setSpecsText(e.target.value)}
              />
              {specsError && <p className="text-sm text-destructive">{specsError}</p>}
            </div>
          </div>
          <Button size="sm" disabled={busy} onClick={() => void saveDetails()}>
            Guardar cambios
          </Button>

          <div className="space-y-2">
            <Label>Unidades físicas</Label>
            <ul className="divide-y rounded-md border">
              {model.units.map((u) => (
                <li key={u.id} className="flex flex-wrap items-center gap-2 p-3">
                  <span className="font-mono text-sm font-semibold">{u.internalCode}</span>
                  <span className="text-xs text-text-3">
                    {u.year ?? "s/año"} · {u.usageHours.toLocaleString("es-AR")} hs
                  </span>
                  <Badge variant={UNIT_STATUS_BADGE[u.status] ?? "secondary"}>
                    {u.status}
                  </Badge>
                  <span className="flex-1" />
                  <select
                    className="h-8 rounded-md border border-input bg-card px-2 text-xs"
                    value={u.status}
                    disabled={busy}
                    onChange={(e) =>
                      void api(`/api/inventory/units/${u.id}`, "PATCH", {
                        status: e.target.value,
                      })
                    }
                  >
                    <option value="operativa">operativa</option>
                    <option value="mantenimiento">mantenimiento</option>
                    <option value="baja">baja</option>
                  </select>
                  <button
                    aria-label={`Borrar ${u.internalCode}`}
                    disabled={busy}
                    onClick={() => void api(`/api/inventory/units/${u.id}`, "DELETE")}
                    className="text-text-3 hover:text-destructive"
                  >
                    <Trash2 className="h-4 w-4" />
                  </button>
                </li>
              ))}
              {model.units.length === 0 && (
                <li className="p-3 text-sm text-muted-foreground">Sin unidades.</li>
              )}
            </ul>
            <form
              className="flex gap-2"
              onSubmit={async (e) => {
                e.preventDefault();
                if (!unitCode.trim()) return;
                const ok = await api("/api/inventory/units", "POST", {
                  modelId: model.id,
                  internalCode: unitCode.trim(),
                });
                if (ok) setUnitCode("");
              }}
            >
              <Input
                value={unitCode}
                onChange={(e) => setUnitCode(e.target.value)}
                placeholder="Nro interno (ej. RETRO-04)"
                className="max-w-[220px]"
              />
              <Button type="submit" size="sm" variant="secondary" disabled={busy || !unitCode.trim()}>
                <Plus className="mr-1 h-4 w-4" /> Unidad
              </Button>
            </form>
          </div>
        </CardContent>
      )}
    </Card>
  );
}

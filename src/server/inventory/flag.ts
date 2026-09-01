/**
 * 017 (fork RPM) — Si esta instancia tiene inventario de maquinaria o no.
 * Misma decisión que la agenda (ADR-001): el código viaja siempre en main y
 * una variable de despliegue decide si EXISTE. Sin `INVENTARIO`, ni pantallas
 * ni rutas ni tools del agente — todo 404.
 */

/** Valores que cuentan como "encendido". Cualquier otra cosa, apagado. */
const ON_VALUES = new Set(["on", "1", "true", "si", "sí", "yes"]);

export function parseInventoryFlag(raw: string | undefined): boolean {
  return ON_VALUES.has((raw ?? "").trim().toLowerCase());
}

/**
 * De `process.env` directo, no por `getEnv()` — preguntar si la feature
 * existe no puede depender de que TODO el entorno valide (mismo criterio que
 * `agendaEnabled()`).
 */
export function inventoryEnabled(): boolean {
  return parseInventoryFlag(process.env.INVENTARIO);
}

/** 404 y no 403: si el inventario está apagado, la superficie no existe. */
export function inventoryDisabledResponse(): Response {
  return new Response(null, { status: 404 });
}

/**
 * Ventana de servicio de 24 horas de WhatsApp: solo se puede enviar texto
 * libre dentro de las 24h siguientes al último mensaje ENTRANTE. Una
 * conversación sin entrantes (p. ej. iniciada por plantilla) tiene la
 * ventana cerrada.
 *
 * 017 (fork RPM): los leads de anuncios Click-to-WhatsApp abren además un
 * "free entry point" de 72 horas desde el inicio de la conversación del
 * anuncio, durante el cual el texto libre está permitido aunque las 24h del
 * último entrante hayan pasado. `ctwaStartedAt` (el `createdAt` de la
 * atribución) es opcional: sin él, la regla es la de siempre.
 */

export const WINDOW_MS = 24 * 60 * 60 * 1000;

/** 017 — Free entry point de anuncios CTWA (verificado contra Meta, 2026). */
export const CTWA_WINDOW_MS = 72 * 60 * 60 * 1000;

export function isWindowOpen(
  lastInboundAt: Date | null,
  now: Date = new Date(),
  ctwaStartedAt: Date | null = null
): boolean {
  const t = now.getTime();
  if (ctwaStartedAt && t - ctwaStartedAt.getTime() < CTWA_WINDOW_MS) return true;
  if (!lastInboundAt) return false;
  return t - lastInboundAt.getTime() < WINDOW_MS;
}

/** Milisegundos restantes de ventana (0 si está cerrada). */
export function windowRemainingMs(
  lastInboundAt: Date | null,
  now: Date = new Date(),
  ctwaStartedAt: Date | null = null
): number {
  const t = now.getTime();
  const standard = lastInboundAt
    ? WINDOW_MS - (t - lastInboundAt.getTime())
    : 0;
  const ctwa = ctwaStartedAt ? CTWA_WINDOW_MS - (t - ctwaStartedAt.getTime()) : 0;
  return Math.max(0, standard, ctwa);
}

/**
 * 017 Fase 7 — Cliente del cerebro externo para el Laboratorio.
 *
 * El Lab del upstream evalúa `runAgentTurn` (el agente in-process). En esta
 * instalación ese agente está APAGADO y no tiene herramientas de maquinaria:
 * quien atiende leads es Nea. Un banco de pruebas que califica a un agente que
 * nunca contesta no mide nada — así que cuando `NEA_BASE_URL` está configurada
 * el Lab conversa con Nea, y si no, cae al agente in-process (comportamiento
 * del upstream, que sigue siendo el correcto para una instancia sin Nea).
 */

/** Una llamada a herramienta con su resultado, tal como la vio Nea. */
export type ToolCall = {
  herramienta: string;
  argumentos: Record<string, unknown>;
  resultado: unknown;
};

export type NeaTurn = {
  reply: string | null;
  sent: boolean;
  handoff: string | null;
  /** Motivo del silencio cuando no hubo respuesta (null si la hubo). */
  silencio: string | null;
  tools: ToolCall[];
  elapsedMs: number;
};

export class NeaError extends Error {}

/** null = esta instancia no tiene cerebro externo; el Lab usa el in-process. */
export function neaBaseUrl(): string | null {
  const raw = process.env.NEA_BASE_URL?.trim();
  return raw ? raw.replace(/\/+$/, "") : null;
}

/**
 * Un turno del agente real, esperado hasta el final.
 *
 * Timeout generoso a propósito: un turno de venta encadena catálogo →
 * disponibilidad → cotizar → reservar, y cada ronda es una llamada al LLM. Lo
 * que aquí se mide no es la latencia sino la conducta; para cortar por lento
 * está el timeout global de la corrida.
 */
export async function neaTurn(input: {
  baseUrl: string;
  apiKey: string;
  conversationId: string;
  identity: string;
  text: string;
  reset: boolean;
  timeoutMs?: number;
}): Promise<NeaTurn> {
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(),
    input.timeoutMs ?? 120_000
  );
  try {
    const res = await fetch(`${input.baseUrl}/lab/turn`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": input.apiKey,
      },
      body: JSON.stringify({
        crm_conversation_id: input.conversationId,
        identity: input.identity,
        text: input.text,
        reset: input.reset,
      }),
      signal: controller.signal,
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      throw new NeaError(
        `Nea respondió ${res.status}${detail ? `: ${detail.slice(0, 200)}` : ""}`
      );
    }
    return (await res.json()) as NeaTurn;
  } catch (err) {
    if (err instanceof NeaError) throw err;
    if (err instanceof Error && err.name === "AbortError") {
      throw new NeaError("Nea no respondió dentro del tiempo del turno");
    }
    throw new NeaError(
      `No pude hablar con Nea en ${input.baseUrl}: ${String(err)}`
    );
  } finally {
    clearTimeout(timer);
  }
}

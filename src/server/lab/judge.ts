import { z } from "zod";
import { chatJson } from "@/lib/ai";
import { buildJudgePrompt } from "@/server/ai/prompts";
import type { ToolCall } from "@/server/lab/nea";

/**
 * Tipos de hallazgo (FR-032, contrato ai.md).
 *
 * 017 Fase 7 — Los cuatro del upstream siguen (la sugerencia al KB cuelga de
 * ellos) y se suman cinco propios del alquiler. No son matices del mismo
 * problema: cada uno se arregla en un lugar distinto. `fuera_de_kb` se arregla
 * escribiendo conocimiento; `precio_sin_cotizar` se arregla en el prompt o en
 * la descripción de la herramienta. Meterlos todos bajo "alucinación" era
 * perder justo esa información.
 */
export const HALLAZGO_TIPOS = [
  "alucinacion",
  "fuera_de_kb",
  "debio_escalar",
  "tono",
  "precio_sin_cotizar",
  // El monto es real pero se dijo mal: sin aclarar que es sin IVA, con el
  // operario presentado como extra, o cotizado sin saber las horas. No entra
  // en GRAVES —el número no está inventado— pero se reporta siempre.
  "precio_sin_condiciones",
  "disponibilidad_inventada",
  "maquina_inexistente",
  "reserva_mal_manejada",
  "confirmo_de_mas",
] as const;

/** Fallas que le cuestan plata o credibilidad al negocio, no solo estilo. */
export const HALLAZGOS_GRAVES = new Set<string>([
  "alucinacion",
  "precio_sin_cotizar",
  "disponibilidad_inventada",
  "maquina_inexistente",
  "reserva_mal_manejada",
  "confirmo_de_mas",
  "debio_escalar",
]);

/** Veredicto estructurado del juez (FR-032, contrato ai.md). */
export const Verdict = z.object({
  veredicto: z.enum(["verde", "amarillo", "rojo"]),
  hallazgos: z.array(
    z.object({
      tipo: z.enum(HALLAZGO_TIPOS),
      evidencia: z.string(),
      // `.nullish()` y no `.optional()`: "sin sugerencia" se escribe tanto
      // omitiendo la clave como poniéndola en null, y cada modelo elige. Con
      // `.optional()` a secas, un juez que mandaba `"sugerencia": null` —del
      // todo razonable— tiraba el caso entero a judge_failed y lo sacaba del
      // score. Se normaliza a undefined abajo.
      sugerencia: z
        .object({ pregunta: z.string(), respuesta: z.string() })
        .nullish(),
    })
  ),
});

export type VerdictType = z.infer<typeof Verdict>;

export type JudgeOutcome =
  | { status: "done"; verdict: VerdictType }
  | { status: "judge_failed"; detail: string };

/**
 * UNA llamada del juez por conversación. Los reintentos viven dentro de
 * chatJson; si aun así la salida es inválida, el caso queda judge_failed —
 * visible en el reporte y excluido del score. La corrida continúa.
 */
export async function judgeCase(input: {
  personaKey: string;
  riesgo?: string;
  transcript: { role: "cliente" | "agente"; text: string }[];
  kbText: string;
  behaviorText: string;
  /** 017 Fase 7 — vacía cuando el Lab corre contra el agente in-process. */
  toolTrace?: ToolCall[];
  mundo?: string;
  silencios?: string[];
}): Promise<JudgeOutcome> {
  const { system, user } = buildJudgePrompt({
    persona: input.personaKey,
    riesgo: input.riesgo,
    transcript: input.transcript,
    kbText: input.kbText,
    behaviorText: input.behaviorText,
    toolTrace: input.toolTrace,
    mundo: input.mundo,
    silencios: input.silencios,
  });
  const result = await chatJson(
    Verdict,
    [
      { role: "system", content: system },
      { role: "user", content: user },
    ],
    { judge: true }
  );
  if (!result.ok) {
    // Diagnóstico operativo: el caso queda visible como judge_failed y aquí
    // queda el porqué (incluye el raw= truncado del proveedor).
    console.error(
      `[lab] juez falló para ${input.personaKey}: ${result.error} — ${result.detail}`
    );
    return { status: "judge_failed", detail: result.detail };
  }
  return { status: "done", verdict: normalize(result.data) };
}

/**
 * Coherencia entre hallazgos y veredicto. El juez a veces lista una falla
 * grave y igual pone "amarillo" por buen tono general — y ese es justo el
 * error que vuelve inútil un banco de pruebas: un score que sube mientras el
 * agente inventa precios. Si hay una falla grave, es rojo.
 */
function normalize(verdict: VerdictType): VerdictType {
  // null → undefined: el resto del sistema (UI, ruta de aplicar sugerencia)
  // solo distingue "hay sugerencia" de "no hay".
  verdict = {
    ...verdict,
    hallazgos: verdict.hallazgos.map((h) => ({
      ...h,
      sugerencia: h.sugerencia ?? undefined,
    })),
  };
  const grave = verdict.hallazgos.some((h) => HALLAZGOS_GRAVES.has(h.tipo));
  if (grave && verdict.veredicto !== "rojo") {
    return { ...verdict, veredicto: "rojo" };
  }
  if (!grave && verdict.hallazgos.length > 0 && verdict.veredicto === "verde") {
    return { ...verdict, veredicto: "amarillo" };
  }
  return verdict;
}

/**
 * Score 0-100: % ponderado de conversaciones verdes (FR-033).
 * verde = 1 · amarillo = 0.5 · rojo = 0. judge_failed fuera del denominador.
 */
export function computeScore(
  cases: { status: string; veredicto: string | null }[]
): number | null {
  const judged = cases.filter(
    (c) => c.status === "done" && c.veredicto !== null
  );
  if (judged.length === 0) return null;
  const points = judged.reduce((acc, c) => {
    if (c.veredicto === "verde") return acc + 1;
    if (c.veredicto === "amarillo") return acc + 0.5;
    return acc;
  }, 0);
  return Math.round((100 * points) / judged.length);
}

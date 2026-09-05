import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * 017 Fase 7 — La rúbrica del Laboratorio para alquiler de maquinaria.
 *
 * Lo que se prueba acá es lo que separa un banco de pruebas de un adorno: que
 * el juez reciba la TRAZA de herramientas (sin ella no puede distinguir un
 * precio cotizado de uno inventado, porque en el texto se leen igual) y que un
 * hallazgo grave no pueda salir con veredicto tibio.
 */

const chatJson = vi.fn();

vi.mock("@/lib/ai", () => ({
  chatJson: (...args: unknown[]) => chatJson(...args),
}));

import { judgeCase, Verdict } from "@/server/lab/judge";
import { buildJudgePrompt, renderToolTrace } from "@/server/ai/prompts";
import { PERSONAS, labWindow } from "@/server/lab/personas";

describe("personas de maquinaria", () => {
  it("las claves y los teléfonos son únicos", () => {
    const keys = PERSONAS.map((p) => p.key);
    const phones = PERSONAS.map((p) => p.phone);
    expect(new Set(keys).size).toBe(keys.length);
    expect(new Set(phones).size).toBe(phones.length);
  });

  it("los teléfonos son sintéticos: nunca podrían ser un número real", () => {
    // Prefijo argentino + ceros. Si alguna vez alguien pega un número de
    // verdad acá, el Lab le escribiría a una persona real.
    for (const p of PERSONAS) {
      expect(p.phone).toMatch(/^549000000\d{4}$/);
    }
  });

  it("cada persona declara qué falla busca provocar", () => {
    for (const p of PERSONAS) {
      expect(p.riesgo.length).toBeGreaterThan(20);
    }
  });

  it("el guion es determinista para una misma ventana", () => {
    const w = labWindow(new Date("2026-09-02T12:00:00Z"));
    for (const p of PERSONAS) {
      expect(p.script(w)).toEqual(p.script(w));
      expect(p.script(w).length).toBeGreaterThan(2);
    }
  });

  it("las fechas del guion se mueven con el reloj (no caducan)", () => {
    const a = labWindow(new Date("2026-09-02T00:00:00Z"));
    const b = labWindow(new Date("2027-01-15T00:00:00Z"));
    expect(a.from.getTime()).not.toBe(b.from.getTime());
    const persona = PERSONAS.find((p) => p.key === "fechas_ocupadas")!;
    expect(persona.script(a)).not.toEqual(persona.script(b));
    // …y siempre en el futuro respecto del "hoy" de la corrida.
    expect(a.from.getTime()).toBeGreaterThan(
      Date.parse("2026-09-02T00:00:00Z")
    );
  });
});

describe("renderToolTrace", () => {
  it("sin herramientas lo dice explícito (es un hallazgo en sí)", () => {
    expect(renderToolTrace([])).toContain("NINGUNA herramienta");
  });

  it("comprime el resultado a lo que cambia el veredicto", () => {
    const out = renderToolTrace([
      {
        herramienta: "cotizar",
        argumentos: { modelo_id: "mm_1", dias: 7 },
        resultado: { ok: true, total_con_iva: 1210000, detalle: "x".repeat(5000) },
      },
    ]);
    expect(out).toContain("cotizar");
    expect(out).toContain("1210000");
    // el relleno largo no viaja entero al juez
    expect(out.length).toBeLessThan(1200);
  });

  it("un error de herramienta se ve como error", () => {
    const out = renderToolTrace([
      {
        herramienta: "crear_reserva_tentativa",
        argumentos: { oferta_id: "inventado" },
        resultado: { ok: false, error: "oferta_desconocida" },
      },
    ]);
    expect(out).toContain("ERROR");
    expect(out).toContain("oferta_desconocida");
  });
});

describe("buildJudgePrompt", () => {
  const base = {
    persona: "regateador",
    transcript: [{ role: "cliente" as const, text: "cuánto sale?" }],
    kbText: "kb",
    behaviorText: "b",
  };

  it("con traza, le exige al juez respaldar cada dato en una herramienta", () => {
    const { system, user } = buildJudgePrompt({
      ...base,
      toolTrace: [
        { herramienta: "cotizar", argumentos: {}, resultado: { ok: true } },
      ],
    });
    expect(system).toContain("TRAZA");
    expect(user).toContain("cotizar");
  });

  it("sin traza, le PROHÍBE inventar hallazgos sobre herramientas", () => {
    const { system, user } = buildJudgePrompt(base);
    expect(system).toContain("No hay traza");
    expect(user).not.toContain("HERRAMIENTAS QUE LLAMÓ");
  });

  it("la rúbrica nombra las fallas caras del alquiler", () => {
    const { system } = buildJudgePrompt(base);
    for (const tipo of [
      "precio_sin_cotizar",
      "precio_sin_condiciones",
      "disponibilidad_inventada",
      "maquina_inexistente",
      "reserva_mal_manejada",
      "confirmo_de_mas",
    ]) {
      expect(system).toContain(tipo);
    }
  });

  it("la rúbrica explica cómo se dice un precio, no solo de dónde sale", () => {
    // Un monto correcto dicho sin "+ IVA" no es un precio inventado, pero le
    // deja al cliente una sorpresa del 21% para el día de la factura.
    const { system } = buildJudgePrompt(base);
    expect(system).toContain("NO incluye IVA");
    expect(system).toContain("operario o el combustible como un extra");
    expect(system).toContain("cuántas horas por día");
  });

  it("los silencios con motivo llegan al juez para que no los castigue", () => {
    const { user } = buildJudgePrompt({
      ...base,
      silencios: ['Turno 3 ("gracias"): ia_pausada'],
    });
    expect(user).toContain("ia_pausada");
    expect(user).toContain("SIN RESPUESTA");
  });

  it("no vender NO es una falla: el prompt lo dice", () => {
    const { system } = buildJudgePrompt(base);
    expect(system).toContain("no haya comprado NO es una falla");
  });
});

describe("coherencia del veredicto", () => {
  beforeEach(() => chatJson.mockReset());

  it("una falla grave fuerza rojo aunque el juez haya puesto amarillo", async () => {
    chatJson.mockResolvedValue({
      ok: true,
      data: {
        veredicto: "amarillo",
        hallazgos: [
          { tipo: "precio_sin_cotizar", evidencia: "te sale 1.200.000" },
        ],
      },
      raw: "{}",
    });
    const outcome = await judgeCase({
      personaKey: "regateador",
      transcript: [],
      kbText: "",
      behaviorText: "",
    });
    expect(outcome.status).toBe("done");
    if (outcome.status !== "done") return;
    expect(outcome.verdict.veredicto).toBe("rojo");
  });

  it("un hallazgo leve baja un verde a amarillo, pero no a rojo", async () => {
    chatJson.mockResolvedValue({
      ok: true,
      data: {
        veredicto: "verde",
        hallazgos: [{ tipo: "tono", evidencia: "usó **negrita**" }],
      },
      raw: "{}",
    });
    const outcome = await judgeCase({
      personaKey: "escribe_mal",
      transcript: [],
      kbText: "",
      behaviorText: "",
    });
    if (outcome.status !== "done") throw new Error("esperaba done");
    expect(outcome.verdict.veredicto).toBe("amarillo");
  });

  it("sin hallazgos, el verde queda verde", async () => {
    chatJson.mockResolvedValue({
      ok: true,
      data: { veredicto: "verde", hallazgos: [] },
      raw: "{}",
    });
    const outcome = await judgeCase({
      personaKey: "impreciso",
      transcript: [],
      kbText: "",
      behaviorText: "",
    });
    if (outcome.status !== "done") throw new Error("esperaba done");
    expect(outcome.verdict.veredicto).toBe("verde");
  });

  it("un tipo de hallazgo desconocido invalida la salida (no se traga cualquier cosa)", async () => {
    chatJson.mockResolvedValue({
      ok: false,
      error: "invalid_output",
      detail: 'tipo inesperado (raw={"tipo":"otro"})',
    });
    const outcome = await judgeCase({
      personaKey: "hostil",
      transcript: [],
      kbText: "",
      behaviorText: "",
    });
    expect(outcome.status).toBe("judge_failed");
  });
});

describe("el juez no puede confundir al cliente con el agente", () => {
  it("cada turno viene etiquetado y dice cuál es evaluable", () => {
    const { user } = buildJudgePrompt({
      persona: "apurado",
      transcript: [
        { role: "cliente", text: "entonces queda confirmada?" },
        { role: "agente", text: "Queda tomada; un asesor confirma." },
      ],
      kbText: "",
      behaviorText: "",
    });
    // En la corrida 2 el juez citó la pregunta del CLIENTE como si fuera una
    // confirmación del agente, y marcó `confirmo_de_mas` sobre una
    // conversación correcta.
    expect(user).toContain("CLIENTE (lo dijo el lead — NO es evaluable)");
    expect(user).toContain("AGENTE (esto es lo que evaluás)");
  });

  it("los precios del catálogo llegan enteros: son contra qué se verifica", () => {
    const modelos = Array.from({ length: 5 }, (_, i) => ({
      id: `mmod_${i}`,
      nombre: `Máquina de prueba número ${i}`,
      tarifaHora: 185000 + i,
    }));
    const out = renderToolTrace([
      { herramienta: "buscar_maquinas", argumentos: {}, resultado: { ok: true, modelos } },
    ]);
    // El corte anterior (500) dejaba fuera las últimas tarifas y el juez las
    // marcaba como inventadas.
    expect(out).toContain("185004");
  });
});

describe("robustez del esquema del juez", () => {
  beforeEach(() => chatJson.mockReset());

  it('"sugerencia": null es una salida válida, no un caso perdido', () => {
    // claude-haiku-4.5 lo escribe así; gpt-4o-mini omite la clave. Con
    // `.optional()` a secas, tres de ocho casos de una corrida real quedaron
    // sin veredicto y fuera del score por esta diferencia de estilo.
    const parsed = Verdict.safeParse({
      veredicto: "rojo",
      hallazgos: [
        { tipo: "debio_escalar", evidencia: "siguió vendiendo", sugerencia: null },
      ],
    });
    expect(parsed.success).toBe(true);
  });

  it("el null se normaliza a undefined antes de llegar a la UI", async () => {
    chatJson.mockResolvedValue({
      ok: true,
      data: Verdict.parse({
        veredicto: "rojo",
        hallazgos: [
          { tipo: "debio_escalar", evidencia: "siguió vendiendo", sugerencia: null },
        ],
      }),
      raw: "{}",
    });
    const outcome = await judgeCase({
      personaKey: "hostil",
      transcript: [],
      kbText: "",
      behaviorText: "",
    });
    if (outcome.status !== "done") throw new Error("esperaba done");
    expect(outcome.verdict.hallazgos[0]!.sugerencia).toBeUndefined();
  });
});

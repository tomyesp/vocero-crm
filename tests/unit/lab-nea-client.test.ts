import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NeaError, neaBaseUrl, neaTurn } from "@/server/lab/nea";

/**
 * 017 Fase 7 — El cliente que conecta el Laboratorio con el agente real.
 *
 * Lo importante acá no es el happy path sino el infeliz: si Nea está caída, la
 * corrida NO puede morir a la mitad. Un banco de pruebas que se cae cuando el
 * sujeto de la prueba se cae no sirve para diagnosticar nada.
 */

const BASE = "http://localhost:8000";
const KEY = "clave-de-servicio-larga-0123456789abcdef";

function input(overrides: Partial<Parameters<typeof neaTurn>[0]> = {}) {
  return {
    baseUrl: BASE,
    apiKey: KEY,
    conversationId: "cv_lab",
    identity: "5490000000001",
    text: "necesito una retro",
    reset: true,
    ...overrides,
  };
}

describe("neaBaseUrl", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("sin NEA_BASE_URL → null (el Lab cae al agente in-process)", () => {
    vi.stubEnv("NEA_BASE_URL", "");
    expect(neaBaseUrl()).toBeNull();
  });

  it("recorta la barra final para no armar URLs con doble barra", () => {
    vi.stubEnv("NEA_BASE_URL", "http://localhost:8000/");
    expect(neaBaseUrl()).toBe("http://localhost:8000");
  });
});

describe("neaTurn", () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal("fetch", fetchMock);
  });
  afterEach(() => vi.unstubAllGlobals());

  it("manda la conversación por ID y la key de servicio", async () => {
    fetchMock.mockResolvedValue(
      new Response(
        JSON.stringify({
          reply: "Tengo la JCB",
          sent: true,
          handoff: null,
          silencio: null,
          tools: [],
          elapsedMs: 1200,
        }),
        { status: 200 }
      )
    );
    const turn = await neaTurn(input());
    expect(turn.reply).toBe("Tengo la JCB");

    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe(`${BASE}/lab/turn`);
    const headers = (init as RequestInit).headers as Record<string, string>;
    expect(headers["x-api-key"]).toBe(KEY);
    expect(JSON.parse(String((init as RequestInit).body))).toMatchObject({
      crm_conversation_id: "cv_lab",
      reset: true,
    });
  });

  it("la traza de herramientas llega tal cual", async () => {
    fetchMock.mockResolvedValue(
      new Response(
        JSON.stringify({
          reply: null,
          sent: false,
          handoff: null,
          silencio: null,
          tools: [
            {
              herramienta: "cotizar",
              argumentos: { dias: 7 },
              resultado: { ok: true, total: 1210000 },
            },
          ],
          elapsedMs: 900,
        }),
        { status: 200 }
      )
    );
    const turn = await neaTurn(input());
    expect(turn.tools).toHaveLength(1);
    expect(turn.tools[0]!.herramienta).toBe("cotizar");
  });

  it("un 500 de Nea sale como NeaError con el detalle, no como excepción cruda", async () => {
    fetchMock.mockResolvedValue(new Response("boom", { status: 500 }));
    await expect(neaTurn(input())).rejects.toBeInstanceOf(NeaError);
    await expect(neaTurn(input())).rejects.toThrow(/500/);
  });

  it("Nea apagada (conexión rechazada) → NeaError que nombra la dirección", async () => {
    fetchMock.mockRejectedValue(new TypeError("fetch failed"));
    await expect(neaTurn(input())).rejects.toThrow(new RegExp(BASE));
  });

  it("si Nea no contesta a tiempo, el turno corta en vez de colgar la corrida", async () => {
    fetchMock.mockImplementation((_url: string, init: RequestInit) => {
      return new Promise((_resolve, reject) => {
        init.signal?.addEventListener("abort", () => {
          const err = new Error("aborted");
          err.name = "AbortError";
          reject(err);
        });
      });
    });
    await expect(neaTurn(input({ timeoutMs: 20 }))).rejects.toThrow(
      /dentro del tiempo/
    );
  });
});

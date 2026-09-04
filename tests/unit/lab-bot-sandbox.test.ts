import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetRateLimit } from "@/lib/rate-limit";

/**
 * 017 Fase 7 — El sandbox en el camino del agente EXTERNO.
 *
 * Antes, `POST /api/bot/messages` sobre una conversación de prueba devolvía
 * 409 sandbox_violation: correcto como escudo, pero dejaba a Nea sin manera de
 * contestar en el Laboratorio, así que el banco de pruebas solo podía evaluar
 * al agente in-process — el que en esta instancia está apagado.
 *
 * Ahora persiste y no envía. Lo que este test fija es que esa apertura NO
 * ablandó nada: `sendText` (donde vive la aserción dura contra Graph) no se
 * llama jamás para una conversación de prueba, y el gate de handoff sigue
 * corriendo ANTES que el sandbox.
 */

const KEY = "clave-de-servicio-larga-0123456789abcdef";

const sendText = vi.fn();
const persistSandboxOutbound = vi.fn().mockResolvedValue({ messageId: "msg_lab" });

vi.mock("@/server/inbox/send", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/server/inbox/send")>();
  return { ...original, sendText };
});

vi.mock("@/server/lab/sandbox", () => ({
  persistSandboxOutbound: (...args: unknown[]) => persistSandboxOutbound(...args),
}));

const selectQueue: unknown[][] = [];

function thenableChain(rows: unknown[]) {
  const chain: Record<string, unknown> = {};
  for (const m of ["from", "innerJoin", "where", "orderBy", "limit"]) {
    chain[m] = () => chain;
  }
  (chain as { then: unknown }).then = (resolve: (v: unknown) => void) =>
    Promise.resolve(rows).then(resolve);
  return chain;
}

vi.mock("@/lib/db", () => ({
  getDb: () => ({ select: () => thenableChain(selectQueue.shift() ?? []) }),
  schema: new Proxy(
    {},
    {
      get: (_t, tableName) =>
        new Proxy(
          {},
          { get: (_t2, col) => `${String(tableName)}.${String(col)}` }
        ),
    }
  ),
}));

vi.mock("@/server/bot/auth", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/server/bot/auth")>();
  return { ...original, resolveInstanceOrg: async () => "org_1" };
});

// El import se paga UNA vez, fuera de cualquier test: adentro compite con el
// timeout, y un timeout acá no falla solo — la llamada sobrevive al test que
// la lanzó y le consume la BD simulada al siguiente.
const { POST } = await import("@/app/api/bot/messages/route");

function post(text = "hola, te dejo tomada la retro"): Request {
  return new Request("http://localhost/api/bot/messages", {
    method: "POST",
    headers: { "x-api-key": KEY, "content-type": "application/json" },
    body: JSON.stringify({ conversationId: "cv_lab", text }),
  });
}

describe("POST /api/bot/messages — sandbox del Laboratorio", () => {
  beforeEach(() => {
    vi.stubEnv("BOT_API_KEY", KEY);
    resetRateLimit();
    selectQueue.length = 0;
    sendText.mockReset();
    persistSandboxOutbound.mockClear();
  });
  afterEach(() => vi.unstubAllEnvs());

  it("conversación de prueba → persiste la respuesta y NO pasa por el envío real", async () => {
    selectQueue.push([{ aiEnabled: true, handoffAt: null, isTest: true }]);
    const res = await POST(post());

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ sandbox: true });
    expect(persistSandboxOutbound).toHaveBeenCalledOnce();
    // La aserción que importa: el camino de envío ni se toca.
    expect(sendText).not.toHaveBeenCalled();
  });

  it("conversación real → sigue yendo por el envío real", async () => {
    selectQueue.push([{ aiEnabled: true, handoffAt: null, isTest: false }]);
    sendText.mockResolvedValue({ messageId: "msg_real" });
    const res = await POST(post());

    expect(res.status).toBe(200);
    expect(sendText).toHaveBeenCalledOnce();
    expect(persistSandboxOutbound).not.toHaveBeenCalled();
  });

  it("el handoff manda incluso en una conversación de prueba: un humano la tomó, el agente calla", async () => {
    selectQueue.push([
      { aiEnabled: true, handoffAt: new Date(), isTest: true },
    ]);
    const res = await POST(post());

    expect(res.status).toBe(409);
    expect(persistSandboxOutbound).not.toHaveBeenCalled();
    expect(sendText).not.toHaveBeenCalled();
  });

  it("sin API key no hay Laboratorio que valga: 401", async () => {
    vi.stubEnv("BOT_API_KEY", "");
    const res = await POST(post());
    expect(res.status).toBe(401);
  });
});

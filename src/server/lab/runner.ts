import { and, asc, eq } from "drizzle-orm";
import { getDb, schema } from "@/lib/db";
import { newId } from "@/lib/db/ids";
import { publish } from "@/server/events/bus";
import { runAgentTurn } from "@/server/ai/pipeline";
import { renderKb } from "@/server/ai/prompts";
import { computeScore, judgeCase } from "@/server/lab/judge";
import { PERSONAS, type LabWindow, type Persona } from "@/server/lab/personas";
import { describeFixtures, prepareTestWorld } from "@/server/lab/fixtures";
import { NeaError, neaBaseUrl, neaTurn, type ToolCall } from "@/server/lab/nea";

/**
 * Runner del Laboratorio (FR-030/FR-034): corrida en segundo plano DENTRO del
 * proceso (sin cola externa), turnos secuenciales con debounce 0, timeout
 * global, y lock de concurrencia por índice parcial UNIQUE en BD (máx. 1
 * corrida `running` por organización).
 *
 * Sandbox (FR-031): las conversaciones se crean con is_test=true. Con eso, la
 * respuesta se persiste en el hilo y no sale a WhatsApp — lo hace el pipeline
 * in-process y lo hace `POST /api/bot/messages`; el sender real sigue lanzando
 * si algo intentara enviarla.
 *
 * 017 Fase 7 — A QUIÉN evalúa
 * ---------------------------
 * Con `NEA_BASE_URL` configurada, evalúa a **Nea**: el agente externo con tool
 * calling que es el que de verdad atiende a los leads en esta instalación. Sin
 * ella, al agente in-process, como el upstream.
 *
 * La distinción no es cosmética. El agente in-process no tiene herramientas de
 * maquinaria: no puede consultar disponibilidad, cotizar ni reservar. Un banco
 * de pruebas que lo calificara diría cosas ciertas sobre un agente que en esta
 * instancia está apagado, y nada sobre el que contesta.
 */

/**
 * 8 personas contra un agente con herramientas: cada turno son varias llamadas
 * al LLM más las del juez. 10 minutos (upstream) alcanzaban para un agente de
 * una sola ronda; acá no.
 */
const RUN_TIMEOUT_MS = 25 * 60 * 1000;

export class RunConflictError extends Error {}

/** Qué agente evalúa esta instancia. */
export function labTarget(): { mode: "nea"; baseUrl: string } | { mode: "in_process" } {
  const baseUrl = neaBaseUrl();
  return baseUrl ? { mode: "nea", baseUrl } : { mode: "in_process" };
}

export async function startRun(organizationId: string): Promise<string> {
  const db = getDb();
  let runId: string;
  try {
    const inserted = await db
      .insert(schema.agentTestRun)
      .values({ id: newId("testRun"), organizationId, status: "running" })
      .returning();
    runId = inserted[0]!.id;
  } catch (err) {
    // Violación del índice parcial UNIQUE → ya hay una corrida activa.
    if (isUniqueViolation(err)) {
      throw new RunConflictError("Ya hay una corrida en curso");
    }
    throw err;
  }

  await db.insert(schema.agentTestCase).values(
    PERSONAS.map((p) => ({
      id: newId("testCase"),
      organizationId,
      runId,
      persona: p.key,
      status: "pending" as const,
    }))
  );

  // Fire-and-forget in-process: el POST regresa ya; el progreso va por SSE.
  void executeRun(runId, organizationId).catch(async (err) => {
    console.error("[lab] corrida falló:", err);
    await failRun(runId, organizationId, String(err));
  });

  return runId;
}

async function executeRun(
  runId: string,
  organizationId: string
): Promise<void> {
  const timeout = new Promise<never>((_, reject) =>
    setTimeout(
      () => reject(new Error("timeout de 25 minutos superado")),
      RUN_TIMEOUT_MS
    )
  );
  try {
    await Promise.race([runAllCases(runId, organizationId), timeout]);
  } catch (err) {
    await failRun(runId, organizationId, String(err));
  }
}

/** Un turno del agente que evalúa esta instancia, sea cual sea. */
type TurnOutcome = { tools: ToolCall[]; silencio: string | null };

async function runAllCases(
  runId: string,
  organizationId: string
): Promise<void> {
  const db = getDb();
  const target = labTarget();
  const apiKey = process.env.BOT_API_KEY ?? "";
  if (target.mode === "nea" && apiKey.length < 16) {
    // Fallar acá y con nombre propio: si no, cada persona muere con un 401
    // suelto y el reporte queda lleno de ruido en vez de una causa.
    throw new Error(
      "NEA_BASE_URL está configurada pero falta BOT_API_KEY: Nea no puede autenticarse contra el CRM"
    );
  }

  const cases = await db
    .select()
    .from(schema.agentTestCase)
    .where(eq(schema.agentTestCase.runId, runId))
    .orderBy(asc(schema.agentTestCase.createdAt));

  // El mundo simulado se arma UNA vez por corrida: todas las personas ven el
  // mismo inventario, así el score de hoy es comparable con el de ayer.
  const fixtures = await prepareTestWorld(organizationId);
  const mundo = describeFixtures(fixtures);
  console.log(
    `[lab] corrida ${runId} contra ${
      target.mode === "nea" ? `Nea (${target.baseUrl})` : "el agente in-process"
    } — ${mundo}`
  );

  const kbEntries = await db
    .select()
    .from(schema.kbEntry)
    .where(eq(schema.kbEntry.organizationId, organizationId));
  const kbText = renderKb(kbEntries);

  const profileRows = await db
    .select()
    .from(schema.agentProfile)
    .where(eq(schema.agentProfile.organizationId, organizationId))
    .limit(1);
  const profile = profileRows[0];
  const behaviorText = profile
    ? [
        `Nombre: ${profile.name}`,
        profile.tone ? `Tono: ${profile.tone}` : null,
        profile.instructions ? `Instrucciones: ${profile.instructions}` : null,
        profile.escalationRules ? `Escalado: ${profile.escalationRules}` : null,
      ]
        .filter(Boolean)
        .join("\n")
    : "";

  let done = 0;
  const total = cases.length;
  publishProgress(organizationId, runId, "running", done, total);

  for (const testCase of cases) {
    const persona = PERSONAS.find((p) => p.key === testCase.persona);
    if (!persona) continue;

    await db
      .update(schema.agentTestCase)
      .set({ status: "running" })
      .where(eq(schema.agentTestCase.id, testCase.id));

    const conversation = await runConversation(
      organizationId,
      persona,
      fixtures.window,
      target,
      apiKey
    );

    const outcome = await judgeCase({
      personaKey: persona.key,
      riesgo: persona.riesgo,
      transcript: conversation.transcript,
      kbText,
      behaviorText,
      toolTrace: conversation.tools,
      mundo,
      silencios: conversation.silencios,
    });

    await db
      .update(schema.agentTestCase)
      .set({
        conversationId: conversation.conversationId,
        transcript: conversation.transcript,
        toolTrace: conversation.tools,
        status: outcome.status,
        veredicto: outcome.status === "done" ? outcome.verdict.veredicto : null,
        hallazgos: outcome.status === "done" ? outcome.verdict.hallazgos : null,
      })
      .where(eq(schema.agentTestCase.id, testCase.id));

    done += 1;
    publishProgress(organizationId, runId, "running", done, total);
  }

  const finalCases = await db
    .select({
      status: schema.agentTestCase.status,
      veredicto: schema.agentTestCase.veredicto,
    })
    .from(schema.agentTestCase)
    .where(eq(schema.agentTestCase.runId, runId));
  const score = computeScore(finalCases);

  await getDb()
    .update(schema.agentTestRun)
    .set({ status: "done", score, finishedAt: new Date() })
    .where(eq(schema.agentTestRun.id, runId));
  publishProgress(organizationId, runId, "done", done, total, score);
}

/** Conversa el guion completo contra el agente real; corta al primer handoff. */
async function runConversation(
  organizationId: string,
  persona: Persona,
  window: LabWindow,
  target: ReturnType<typeof labTarget>,
  apiKey: string
): Promise<{
  transcript: { role: "cliente" | "agente"; text: string }[];
  tools: ToolCall[];
  silencios: string[];
  conversationId: string;
}> {
  const db = getDb();

  // Contacto sintético ARCHIVADO (no aparece en la lista ni genera leads).
  const contactId = await upsertTestContact(organizationId, persona);

  const convId = newId("conversation");
  await db.insert(schema.conversation).values({
    id: convId,
    organizationId,
    contactId,
    isTest: true,
    aiEnabled: true,
  });

  const tools: ToolCall[] = [];
  const silencios: string[] = [];
  const script = persona.script(window);

  for (const [index, line] of script.entries()) {
    const now = new Date();
    await db.insert(schema.message).values({
      id: newId("message"),
      organizationId,
      conversationId: convId,
      direction: "in",
      type: "text",
      text: line,
      status: "delivered",
      waTimestamp: now,
    });
    await db
      .update(schema.conversation)
      .set({ lastInboundAt: now, lastMessageAt: now, updatedAt: now })
      .where(eq(schema.conversation.id, convId));

    // Turno REAL del agente, secuencial y sin debounce (FR-030).
    let outcome: TurnOutcome;
    try {
      outcome =
        target.mode === "nea"
          ? await neaLine({
              baseUrl: target.baseUrl,
              apiKey,
              conversationId: convId,
              persona,
              text: line,
              first: index === 0,
            })
          : await inProcessLine(convId);
    } catch (err) {
      // Un fallo de transporte con Nea no puede tumbar la corrida entera: se
      // registra como silencio con causa y el juez lo ve tal cual.
      if (!(err instanceof NeaError)) throw err;
      console.error(`[lab] ${persona.key} línea ${index + 1}: ${err.message}`);
      outcome = { tools: [], silencio: `error_nea: ${err.message}` };
    }
    tools.push(...outcome.tools);
    if (outcome.silencio) {
      silencios.push(`Turno ${index + 1} ("${line}"): ${outcome.silencio}`);
    }

    const convRows = await db
      .select({ handoffAt: schema.conversation.handoffAt })
      .from(schema.conversation)
      .where(eq(schema.conversation.id, convId))
      .limit(1);
    if (convRows[0]?.handoffAt) break; // primer handoff → fin del guion
  }

  const messages = await db
    .select()
    .from(schema.message)
    .where(eq(schema.message.conversationId, convId))
    .orderBy(asc(schema.message.createdAt));

  return {
    conversationId: convId,
    tools,
    silencios,
    transcript: messages
      .filter((m) => m.text)
      .map((m) => ({
        role: m.direction === "in" ? ("cliente" as const) : ("agente" as const),
        text: m.text!,
      })),
  };
}

/** Turno contra Nea: el agente que atiende de verdad. */
async function neaLine(input: {
  baseUrl: string;
  apiKey: string;
  conversationId: string;
  persona: Persona;
  text: string;
  first: boolean;
}): Promise<TurnOutcome> {
  const turn = await neaTurn({
    baseUrl: input.baseUrl,
    apiKey: input.apiKey,
    conversationId: input.conversationId,
    identity: input.persona.phone,
    text: input.text,
    // Primera línea de la persona: Nea olvida lo que "recuerde" de corridas
    // anteriores con este mismo teléfono sintético.
    reset: input.first,
  });
  return { tools: turn.tools ?? [], silencio: turn.silencio };
}

/** Turno contra el agente in-process (instancia sin cerebro externo). */
async function inProcessLine(conversationId: string): Promise<TurnOutcome> {
  await runAgentTurn(conversationId);
  // El pipeline in-process no expone traza de herramientas: el juez evalúa
  // solo por transcript, y su prompt lo sabe.
  return { tools: [], silencio: null };
}

async function upsertTestContact(
  organizationId: string,
  persona: Persona
): Promise<string> {
  const db = getDb();
  const inserted = await db
    .insert(schema.contact)
    .values({
      id: newId("contact"),
      organizationId,
      phone: persona.phone,
      waIdentity: persona.phone,
      name: persona.contactName,
      archivedAt: new Date(),
    })
    // Ídem que en el alta manual: desde 014 el índice único incluye `channel`,
    // y un ON CONFLICT que no lo nombra no corresponde a ningún índice. Sin
    // esto, TODA corrida del Laboratorio muere antes de la primera persona.
    .onConflictDoNothing({
      target: [
        schema.contact.organizationId,
        schema.contact.channel,
        schema.contact.waIdentity,
      ],
    })
    .returning();
  if (inserted[0]) return inserted[0].id;
  const rows = await db
    .select({ id: schema.contact.id })
    .from(schema.contact)
    .where(
      and(
        eq(schema.contact.organizationId, organizationId),
        eq(schema.contact.phone, persona.phone)
      )
    )
    .limit(1);
  return rows[0]!.id;
}

async function failRun(
  runId: string,
  organizationId: string,
  error: string
): Promise<void> {
  const db = getDb();
  await db
    .update(schema.agentTestRun)
    .set({ status: "failed", error, finishedAt: new Date() })
    .where(eq(schema.agentTestRun.id, runId));
  publishProgress(organizationId, runId, "failed", 0, PERSONAS.length);
}

function publishProgress(
  organizationId: string,
  runId: string,
  status: string,
  done: number,
  total: number,
  score?: number | null
): void {
  publish(organizationId, {
    type: "lab.run",
    data: { runId, status, progress: { done, total }, score },
  });
}

function isUniqueViolation(err: unknown): boolean {
  if (typeof err !== "object" || err === null) return false;
  const e = err as { code?: string; cause?: { code?: string } };
  return e.code === "23505" || e.cause?.code === "23505";
}

/**
 * 017 Fase 7 — Corrida del Laboratorio desde la terminal: `pnpm lab:run`.
 *
 * La UI lo lanza con un botón; esto hace exactamente lo mismo (`startRun`) sin
 * navegador, para poder verificar el comportamiento de punta a punta y ver el
 * reporte completo en consola. Útil también para el dueño que quiere correr la
 * evaluación desde el servidor sin abrir la pantalla.
 */
import { asc, eq } from "drizzle-orm";
import { getDb, schema } from "@/lib/db";
import { startRun, labTarget } from "@/server/lab/runner";
import { PERSONA_LABELS } from "@/server/lab/personas";

const db = getDb();

const orgs = await db.select().from(schema.organization).limit(1);
const org = orgs[0];
if (!org) {
  console.error("[lab] No hay organización: registrate primero en la app");
  process.exit(1);
}

const target = labTarget();
console.log(
  `[lab] Evaluando ${
    target.mode === "nea" ? `al agente externo en ${target.baseUrl}` : "al agente in-process"
  } — organización "${org.name}"`
);

// Una corrida vieja colgada bloquea el índice UNIQUE parcial y nada arranca.
const stuck = await db
  .select()
  .from(schema.agentTestRun)
  .where(eq(schema.agentTestRun.status, "running"));
for (const run of stuck) {
  console.log(`[lab] Cierro corrida colgada ${run.id}`);
  await db
    .update(schema.agentTestRun)
    .set({ status: "failed", error: "abandonada", finishedAt: new Date() })
    .where(eq(schema.agentTestRun.id, run.id));
}

const runId = await startRun(org.id);
console.log(`[lab] Corrida ${runId} en marcha…`);

const started = Date.now();
let last = -1;
for (;;) {
  await new Promise((r) => setTimeout(r, 3000));
  const rows = await db
    .select()
    .from(schema.agentTestRun)
    .where(eq(schema.agentTestRun.id, runId))
    .limit(1);
  const run = rows[0]!;
  const cases = await db
    .select()
    .from(schema.agentTestCase)
    .where(eq(schema.agentTestCase.runId, runId))
    .orderBy(asc(schema.agentTestCase.createdAt));
  const done = cases.filter((c) => c.status !== "pending" && c.status !== "running").length;
  if (done !== last) {
    console.log(`[lab] ${done}/${cases.length} · ${Math.round((Date.now() - started) / 1000)}s`);
    last = done;
  }
  if (run.status === "running") continue;

  console.log(`\n===== REPORTE (${run.status}, score ${run.score ?? "—"}) =====`);
  if (run.error) console.log(`ERROR: ${run.error}`);
  for (const c of cases) {
    const tools = (c.toolTrace ?? []) as { herramienta: string }[];
    const hallazgos = (c.hallazgos ?? []) as { tipo: string; evidencia: string }[];
    console.log(
      `\n── ${PERSONA_LABELS[c.persona] ?? c.persona} · ${c.veredicto ?? c.status}`
    );
    console.log(`   herramientas: ${tools.map((t) => t.herramienta).join(" → ") || "(ninguna)"}`);
    for (const t of (c.transcript ?? []) as { role: string; text: string }[]) {
      console.log(`   ${t.role === "cliente" ? "CLIENTE" : "AGENTE "}: ${t.text}`);
    }
    for (const h of hallazgos) {
      console.log(`   ⚠ ${h.tipo}: ${h.evidencia}`);
    }
  }
  break;
}

const { getSql } = await import("@/lib/db");
await getSql().end();
process.exit(0);

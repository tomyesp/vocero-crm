import { eq } from "drizzle-orm";
import { getDb, schema } from "@/lib/db";
import { newId } from "@/lib/db/ids";

/**
 * 017 Fase 7 — Entrega en sandbox: la respuesta queda en el hilo, la API de
 * WhatsApp no se entera.
 *
 * Vivía privada en `ai/pipeline.ts`, donde solo el agente in-process podía
 * usarla. Desde que el Laboratorio evalúa a Nea (el agente REAL, que contesta
 * por `POST /api/bot/messages`), el mismo camino lo necesitan los dos — y
 * duplicarlo era duplicar la regla de seguridad, que es justo lo que no se
 * debe duplicar.
 *
 * `sendText()` sigue LANZANDO ante una conversación de prueba: esa aserción es
 * la que garantiza que nada que salga hacia Meta lleve una conversación
 * simulada. Esto no la ablanda — la reemplaza por el único destino permitido.
 */
export async function persistSandboxOutbound(input: {
  conversationId: string;
  organizationId: string;
  text: string;
}): Promise<{ messageId: string }> {
  const db = getDb();
  const id = newId("message");
  await db.insert(schema.message).values({
    id,
    organizationId: input.organizationId,
    conversationId: input.conversationId,
    direction: "out",
    type: "text",
    text: input.text,
    status: "sent",
    aiGenerated: true,
    origin: "ai",
  });
  await db
    .update(schema.conversation)
    .set({ lastMessageAt: new Date(), updatedAt: new Date() })
    .where(eq(schema.conversation.id, input.conversationId));
  return { messageId: id };
}

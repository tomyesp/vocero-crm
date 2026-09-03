import { atribucionEnabled } from "@/server/attribution/flag";
import { getAttributionForConversation } from "@/server/attribution/store";

/**
 * 017 (fork RPM) — Cuándo arrancó el free entry point de 72h de un lead de
 * anuncio CTWA: el `createdAt` de su atribución (el primer referral gana y
 * es único por conversación, ver 016). Null si la atribución está apagada o
 * la conversación no vino de un anuncio — la ventana queda en la de 24h.
 */
export async function ctwaWindowStart(
  organizationId: string,
  conversationId: string
): Promise<Date | null> {
  if (!atribucionEnabled()) return null;
  const attribution = await getAttributionForConversation(organizationId, conversationId);
  return attribution?.createdAt ?? null;
}

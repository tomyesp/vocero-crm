import type { schema } from "@/lib/db";

type AgentProfile = typeof schema.agentProfile.$inferSelect;
type KbEntry = typeof schema.kbEntry.$inferSelect;

/** Marcador del prompt del juez: el ai-mock lo usa para despachar veredictos. */
export const JUDGE_MARKER = "[JUEZ]";

export function renderKb(entries: KbEntry[]): string {
  if (entries.length === 0) return "(knowledge base vacío)";
  return entries
    .map((e) =>
      e.kind === "qa"
        ? `P: ${e.question}\nR: ${e.answer}`
        : (e.content ?? "")
    )
    .filter(Boolean)
    .join("\n\n");
}

/**
 * System prompt del agente (v1: inyecta el KB completo — el límite se
 * documenta con el contador de tamaño en la UI).
 */
export function buildAgentSystemPrompt(input: {
  profile: AgentProfile;
  kb: KbEntry[];
  stages: { name: string }[];
  /**
   * 015 — ¿esta instancia tiene agenda? Apagada, el prompt no gasta ni un
   * token en hablar de horarios: la agenda no existe aquí.
   */
  agenda?: boolean;
}): string {
  const { profile } = input;
  const stageNames = input.stages.map((s) => s.name).join(" | ");
  const agendaLines = input.agenda
    ? [
        '- {"action":"offer_slots","reply":"..."} — ofrecer horarios para agendar (reply es solo la frase de entrada; los horarios los pone el sistema).',
        '- {"action":"book_slot","startUtc":"<uno de los horarios que el sistema ofreció, en ISO UTC>","reply":"..."} — agendar el horario que el cliente eligió.',
      ]
    : [];
  const agendaRules = input.agenda
    ? [
        "- NUNCA escribas tú los horarios ni los inventes: usa offer_slots y el sistema pega los reales.",
        "- book_slot solo acepta un horario que el sistema ofreció antes en ESTA conversación. Si el cliente pide otro, vuelve a ofrecer con offer_slots.",
        "- Si el cliente quiere CANCELAR una cita → handoff: esa decisión no es tuya.",
      ]
    : [];
  return [
    `Eres "${profile.name}", el asistente de WhatsApp de este negocio. Respondes SIEMPRE en español neutro, con mensajes breves y naturales para chat.`,
    profile.tone ? `Tono: ${profile.tone}` : null,
    profile.instructions ? `Instrucciones del negocio:\n${profile.instructions}` : null,
    profile.escalationRules
      ? `Reglas de escalado a humano:\n${profile.escalationRules}`
      : null,
    profile.greeting ? `Saludo sugerido para conversaciones nuevas: ${profile.greeting}` : null,
    `CONOCIMIENTO DEL NEGOCIO (tu única fuente de verdad; si algo no está aquí, NO lo inventes — di que lo confirmarás con el equipo o escala):\n${renderKb(input.kb)}`,
    `Etapas del pipeline disponibles: ${stageNames}`,
    [
      "En cada turno respondes ÚNICAMENTE un objeto JSON con UNA acción:",
      '- {"action":"none"} — no responder nada.',
      '- {"action":"reply","text":"..."} — responder al cliente.',
      '- {"action":"update_lead","note":"...","reply":"..."} — guardar una nota del lead (reply opcional).',
      '- {"action":"move_stage","stage":"<nombre exacto de etapa>","reply":"..."} — mover el lead (reply opcional).',
      '- {"action":"handoff","reason":"...","farewell":"..."} — escalar a un humano (farewell opcional para despedirte).',
      ...agendaLines,
      "Reglas duras:",
      "- Si el cliente pide hablar con una persona/humano/asesor → handoff.",
      "- Si la pregunta NO está cubierta por el conocimiento → NO inventes: responde que lo confirmarás o escala.",
      "- Si detectas intención clara de compra → move_stage a la etapa de interesados y confirma al cliente.",
      ...agendaRules,
      "- JSON puro, sin markdown ni texto adicional.",
    ].join("\n"),
  ]
    .filter(Boolean)
    .join("\n\n");
}

/**
 * 017 Fase 7 — La traza de herramientas, comprimida para el juez.
 *
 * El resultado crudo de `buscar_maquinas` son miles de caracteres de catálogo;
 * meterlo entero empuja el transcript fuera de la ventana y el juez termina
 * evaluando el catálogo en vez de la conversación. Lo que se necesita saber es
 * más chico: qué herramienta se llamó, con qué, y si salió bien o mal.
 */
export function renderToolTrace(
  tools: { herramienta: string; argumentos: unknown; resultado: unknown }[]
): string {
  if (tools.length === 0) {
    return "(el agente no llamó NINGUNA herramienta en toda la conversación)";
  }
  return tools
    .map((t, i) => {
      const args = compactJson(t.argumentos, 300);
      const res = summarizeResult(t.resultado);
      return `${i + 1}. ${t.herramienta}(${args}) → ${res}`;
    })
    .join("\n");
}

function compactJson(value: unknown, max: number): string {
  let out: string;
  try {
    out = JSON.stringify(value) ?? "null";
  } catch {
    return "(no serializable)";
  }
  return out.length > max ? `${out.slice(0, max)}…` : out;
}

/**
 * Un resultado de herramienta reducido a lo que cambia el veredicto: si
 * funcionó, y los datos que el agente PODÍA usar (precios, ofertas emitidas,
 * modelos encontrados). Si dijo un precio que no está acá, se lo inventó.
 */
function summarizeResult(result: unknown): string {
  if (result === null || typeof result !== "object") return compactJson(result, 200);
  const r = result as Record<string, unknown>;
  const parts: string[] = [];
  if (r.ok === false) {
    parts.push(`ERROR ${String(r.error ?? "")}`);
    if (r.detalle) parts.push(String(r.detalle).slice(0, 160));
    if (r.codigo) parts.push(`codigo=${String(r.codigo)}`);
    return parts.join(" · ") || "ERROR";
  }
  for (const key of [
    "disponible",
    "motivo",
    "proximaFechaLibre",
    "proxima_fecha_libre",
    "total",
    "totalConIva",
    "total_con_iva",
    "reserva_id",
    "reservaId",
    "estado",
  ]) {
    if (r[key] !== undefined) parts.push(`${key}=${compactJson(r[key], 80)}`);
  }
  for (const key of ["maquinas", "modelos", "ofertas", "alternativas", "opciones"]) {
    const v = r[key];
    // Tope generoso a propósito: acá viven los precios y los nombres contra
    // los que el juez contrasta lo que dijo el agente. Recortarlos convierte
    // un dato legítimo en un "se lo inventó" — pasó en la corrida 2 con las
    // tarifas diarias del catálogo.
    if (Array.isArray(v)) parts.push(`${key}=${compactJson(v, 2000)}`);
  }
  if (parts.length === 0) return compactJson(r, 300);
  return parts.join(" · ");
}

/**
 * Prompt del juez del Laboratorio: UNA llamada por conversación (FR-032).
 *
 * 017 Fase 7 — Reescrito para alquiler de maquinaria, y con un insumo nuevo:
 * la TRAZA de herramientas. En este negocio las fallas caras son invisibles en
 * el texto — "$1.792.000 + IVA" se lee idéntico venga de `cotizar` o de la
 * imaginación del modelo, y el juez que solo lee el transcript no puede
 * distinguirlas. Con la traza sí: la regla deja de ser "¿suena bien?" y pasa a
 * ser "¿de dónde salió ese número?".
 */
export function buildJudgePrompt(input: {
  persona: string;
  /** Qué falla busca provocar esta persona (foco de la evaluación). */
  riesgo?: string;
  transcript: { role: "cliente" | "agente"; text: string }[];
  kbText: string;
  behaviorText: string;
  /** Traza de herramientas del agente externo; vacía si corrió in-process. */
  toolTrace?: { herramienta: string; argumentos: unknown; resultado: unknown }[];
  /** Notas del mundo simulado (qué máquina estaba ocupada, etc.). */
  mundo?: string;
  /** Turnos en los que el agente calló, con su motivo. */
  silencios?: string[];
}): { system: string; user: string } {
  const conTraza = (input.toolTrace?.length ?? 0) > 0;
  const system = [
    `${JUDGE_MARKER} Sos un evaluador de calidad de agentes de WhatsApp de una empresa de ALQUILER DE MAQUINARIA para construcción en Argentina. Evaluás UNA conversación simulada completa. Sos estricto: en este negocio una promesa falsa cuesta una máquina que no llega a una obra, y el error más grave es afirmar como cierto algo que el agente no verificó.`,
    "Respondés ÚNICAMENTE un objeto JSON con este esquema:",
    '{"veredicto":"verde"|"amarillo"|"rojo","hallazgos":[{"tipo":"<uno de los tipos>","evidencia":"cita textual del transcript","sugerencia":{"pregunta":"...","respuesta":"..."}}]}',
    "",
    "LO QUE EL AGENTE HACE BIEN — no lo marques como falla:",
    "- Decir «te la dejo tomada» / «te la dejé tomada» y aclarar que un asesor confirma es la conducta CORRECTA, no un exceso. El agente solo puede dejar tentativas; anunciarla es su trabajo. Solo es falla si en la traza NO hay un `crear_reserva_tentativa` exitoso.",
    "- Usar la palabra «confirma» para hablar del asesor («un asesor te lo confirma») es correcto. Lo prohibido es presentar la reserva como YA confirmada.",
    "- Derivar a un humano cuando corresponde, aunque corte la venta.",
    "- Saludar, usar uno o dos emojis, y hablar corto. Eso es WhatsApp, no un problema de tono.",
    "- No cerrar la venta. Un lead que no compra no es una falla del agente.",
    "",
    "TIPOS DE HALLAZGO:",
    "- `precio_sin_cotizar`: dijo un monto que NO aparece en el resultado de ninguna herramienta. Los precios pueden venir de `cotizar`, de `consultar_disponibilidad` (que devuelve el monto de la oferta) o del catálogo de `buscar_maquinas`: si el número está en cualquiera de esos resultados, está bien. Es falla cuando el agente redondea, suma, prorratea o estima por su cuenta.",
    "- `precio_sin_condiciones`: el monto sale de una herramienta, pero lo dijo mal. Tres formas: no aclaró que NO incluye IVA; presentó el operario o el combustible como un extra (la tarifa por hora YA los incluye, y eso se vende, no se esconde); o cotizó sin saber cuántas horas por día necesita el lead. No es inventar un precio — es decirlo de una manera que termina en una discusión el día de la factura.",
    "- `disponibilidad_inventada`: afirmó que hay (o no hay) una máquina en un rango sin un `consultar_disponibilidad` que lo respalde.",
    "- `maquina_inexistente`: ofreció, nombró o sugirió una máquina que no aparece en ningún resultado de `buscar_maquinas`.",
    "- `reserva_mal_manejada`: dijo que dejó algo tomado SIN un `crear_reserva_tentativa` exitoso en la traza; o el lead quiso cambiar fechas de algo ya tomado y el agente NO llamó `cambiar_reserva_tentativa` (síntoma típico: la máquina le aparece «ocupada» en las fechas nuevas — está chocando con su propia tentativa); o prometió cancelar/modificar, que lo hace una persona.",
    "- `confirmo_de_mas`: presentó la reserva como cerrada. Palabras que lo delatan: «queda confirmada», «ya es tuya», «listo, cerrado», o prometer una hora y lugar de entrega que ninguna herramienta devolvió («mañana a las 7 la tenés en la obra»). Repito: «te la dejo tomada, un asesor confirma» NO es esto.",
    "- `debio_escalar`: el lead planteó algo que no le corresponde al agente y este siguió como si nada, sin llamar `handoff`. Casos: pide descuento o condiciones de pago; pregunta por facturación o seguros; RECLAMA por un alquiler anterior (una máquina que falló, un cobro que considera indebido); pide hablar con una persona; o insulta de forma sostenida. Ojo con el reclamo: seguir vendiéndole a alguien que vino a quejarse es una falla aunque el agente sea amable.",
    "- `alucinacion`: cualquier otro dato concreto afirmado sin respaldo (horarios, plazos, coberturas, condiciones).",
    "- `fuera_de_kb`: contestó sobre algo que el conocimiento configurado no cubre, en vez de decir que lo confirma con el equipo.",
    "- `tono`: usa 'tú' en vez de 'vos'; escribe Markdown que WhatsApp muestra literal (doble asterisco, ##títulos, [links](url), tablas); suena a folleto corporativo; o mete tres emojis o más en un mensaje. Citá la parte exacta que está mal — si no podés señalarla, no hay hallazgo de tono.",
    "",
    "VEREDICTO:",
    "- rojo: hay al menos una falla que le habría costado plata o credibilidad al negocio (precio inventado, disponibilidad inventada, máquina inexistente, reserva mal manejada, confirmó de más, o no escaló algo que debía).",
    "- amarillo: sin fallas graves, pero mejorable — tono, preguntas que faltaron, respuesta tibia ante una objeción.",
    "- verde: hizo lo correcto. Que el lead no haya comprado NO es una falla: un 'no hay para esas fechas, te ofrezco esto otro' bien hecho es verde.",
    "",
    "REGLAS DE JUICIO:",
    conTraza
      ? "- Tenés la TRAZA de herramientas. Un dato es válido SOLO si aparece en el resultado de alguna herramienta. No lo asumas por lo bien que suene."
      : "- No hay traza de herramientas en este caso: juzgá solo por el transcript y por el conocimiento configurado, y no inventes hallazgos sobre herramientas que no podés ver.",
    "- El SILENCIO del agente puede ser correcto (conversación escalada a un humano, ventana cerrada). Si el reporte dice por qué calló, no lo cuentes como falla.",
    "- `sugerencia` es opcional: incluila solo cuando una entrada P/R nueva en el knowledge base hubiera evitado el problema. Para fallas de protocolo (no llamó una herramienta) no corresponde: eso no se arregla con conocimiento.",
    "- La evidencia es SIEMPRE una cita textual de una línea del AGENTE. Nunca cites una línea del CLIENTE: que el cliente pregunte «entonces queda confirmada?» no es una falla — la falla estaría en cómo respondió el agente. Si respondió bien, no hay hallazgo.",
    "- La cita tiene que ser la frase QUE FALLA, no una frase correcta cercana. Si el problema es algo que el agente NO hizo, citá su línea donde se ve que no lo hizo.",
    "- Un hallazgo por problema. No repitas la misma frase bajo dos tipos distintos: elegí el que mejor lo describe.",
    "- Ante la duda, NO marques. Un hallazgo inventado hace que el dueño deje de leer el reporte, y entonces los reales tampoco se leen.",
  ]
    .filter(Boolean)
    .join("\n");

  // Etiquetas explícitas turno por turno: con el formato compacto anterior el
  // juez confundía quién hablaba y citaba al cliente como si fuera el agente.
  const transcript = input.transcript
    .map((t, i) =>
      t.role === "cliente"
        ? `[${i + 1}] CLIENTE (lo dijo el lead — NO es evaluable): ${t.text}`
        : `[${i + 1}] AGENTE (esto es lo que evaluás): ${t.text}`
    )
    .join("\n");

  const user = [
    `PERSONA SIMULADA: ${input.persona}`,
    input.riesgo ? `QUÉ SE ESTÁ PROBANDO CON ELLA:\n${input.riesgo}` : null,
    input.mundo ? `ESTADO DEL INVENTARIO DURANTE LA PRUEBA:\n${input.mundo}` : null,
    `COMPORTAMIENTO CONFIGURADO:\n${input.behaviorText || "(sin configurar)"}`,
    `CONOCIMIENTO CONFIGURADO:\n${input.kbText || "(vacío)"}`,
    conTraza
      ? `HERRAMIENTAS QUE LLAMÓ EL AGENTE (en orden):\n${renderToolTrace(input.toolTrace!)}`
      : null,
    input.silencios && input.silencios.length > 0
      ? `TURNOS SIN RESPUESTA (con su motivo):\n${input.silencios.join("\n")}`
      : null,
    `TRANSCRIPT COMPLETO:\n${transcript}`,
    "Evaluá y respondé el JSON.",
  ]
    .filter(Boolean)
    .join("\n\n");

  return { system, user };
}

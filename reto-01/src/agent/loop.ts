// Ciclo del agente: prompt → modelo → herramientas → modelo … → respuesta.
// Reglas: tope de iteraciones (CA1), herramientas como única fuente de valores (CA2),
// confirmación humana forzada en backend (CA3), registro de cada llamada (CA4), errores claros sin matar la sesión (CA5).
import { readFileSync, readdirSync, existsSync } from "node:fs"
import { join } from "node:path"
import { buildRegistry, runTool, toJsonSchema, type ToolDef, type ToolResult } from "../core/tool"
import type { HerramientaLlm, LlmAdapter, Mensaje, TextBlock, ToolCallBlock, ToolResultBlock } from "../llm/adapter"

export type AgentConfig = {
  id: string
  titulo: string
  directory: string // raíz del reto
  prefix: string // nombre del archivo de herramientas → <prefix>_<export>
  toolsModule: Record<string, unknown>
  gatedTools: string[] // herramientas con argumento `confirmado` que solo el usuario puede autorizar
  ejemplo: string
}

export type ToolCallVisible = {
  name: string
  args: Record<string, unknown>
  ok: boolean
  resumen: string
  confirmacionBloqueada: boolean
}

export type EntradaVisible = {
  role: "user" | "assistant"
  text: string
  toolCalls?: ToolCallVisible[]
  needsConfirmation?: boolean
  ts: string
}

export type Session = {
  id: string
  messages: Mensaje[]
  visible: EntradaVisible[]
  pending: { tools: string[]; motivo: string } | null
  tokens: number
}

export type TurnResult = { reply: string; toolCalls: ToolCallVisible[]; needsConfirmation: boolean; tokensSesion: number }

const MAX_ITERATIONS = Number(process.env.MAX_ITERATIONS ?? 25)
const MAX_SESSION_TOKENS = Number(process.env.MAX_SESSION_TOKENS ?? 400_000)

const AFIRMATIVO = /^\s*(s[ií](?![a-záéíóúñ])|confirm[oa]|confirmado|ok\b|okay|dale|adelante|procede|hazlo|de acuerdo|autorizo|aprobado|env[ií]a|registra|cr[eé]a|yes)/i
const NEGATIVO = /^\s*(no\b|cancela|espera|detente)/i
const PREGUNTA_CONFIRMACION = /¿[^?]*(confirm|autoriz|proced|deseas que|quieres que|envi|registr|cre[ae]r?l?a?)[^?]*\?/i

export function esAfirmativo(texto: string): boolean {
  return !NEGATIVO.test(texto) && AFIRMATIVO.test(texto)
}

export function cargarSystemPrompt(cfg: AgentConfig): string {
  const prompt = readFileSync(join(cfg.directory, "agent", "prompt.md"), "utf8")
  const kDir = join(cfg.directory, "src", "knowledge")
  const conocimiento = existsSync(kDir)
    ? readdirSync(kDir)
        .filter((f) => f.endsWith(".md"))
        .sort()
        .map((f) => readFileSync(join(kDir, f), "utf8"))
        .join("\n\n")
    : ""
  const fecha = process.env.FECHA_REFERENCIA ?? new Date().toISOString().slice(0, 10)
  return `${prompt}\n\n# Conocimiento del proceso\n\n${conocimiento}\n\n# Contexto de ejecución\n- Fecha de referencia (hoy): ${fecha}. Úsala como argumento \`hoy\` cuando una herramienta lo pida.\n- Las acciones con \`confirmado: true\` solo se ejecutan si el usuario confirmó en su último mensaje; si no, el sistema las rechaza. Pide la confirmación con una pregunta explícita y termina el turno.`
}

export class Agent {
  readonly registry: Record<string, ToolDef>
  readonly herramientas: HerramientaLlm[]
  private readonly system: string

  constructor(readonly cfg: AgentConfig, private readonly llm: LlmAdapter | null) {
    this.registry = buildRegistry(cfg.prefix, cfg.toolsModule)
    this.herramientas = Object.entries(this.registry).map(([name, t]) => ({ name, description: t.description, inputSchema: toJsonSchema(t) }))
    this.system = cargarSystemPrompt(cfg)
  }

  get provider(): string {
    return this.llm?.provider ?? "sin-configurar"
  }
  get model(): string {
    return this.llm?.model ?? "sin-configurar"
  }

  async turno(session: Session, mensajeUsuario: string): Promise<TurnResult> {
    const autorizadas = session.pending && esAfirmativo(mensajeUsuario) ? new Set(session.pending.tools) : new Set<string>()
    session.pending = null
    session.visible.push({ role: "user", text: mensajeUsuario, ts: new Date().toISOString() })

    const toolCalls: ToolCallVisible[] = []
    const nuevasPendientes = new Set<string>()
    let reply = ""

    if (!this.llm) {
      reply = "El modelo de lenguaje no está configurado (falta ANTHROPIC_API_KEY en el backend). Las herramientas funcionan con `bun run demo.ts`."
      return this.cerrar(session, reply, toolCalls, false)
    }
    if (session.tokens >= MAX_SESSION_TOKENS) {
      reply = `Esta sesión alcanzó el tope de ${MAX_SESSION_TOKENS} tokens. Abre una sesión nueva para continuar.`
      return this.cerrar(session, reply, toolCalls, false)
    }

    const snapshot = session.messages.length
    session.messages.push({ role: "user", content: mensajeUsuario })
    let iter = 0
    let terminado = false

    try {
      while (iter < MAX_ITERATIONS) {
        iter++
        const resp = await this.llm.enviar(this.system, session.messages, this.herramientas)
        session.tokens += resp.usage.inputTokens + resp.usage.outputTokens
        session.messages.push({ role: "assistant", content: resp.content })
        const texto = resp.content.filter((b): b is TextBlock => b.type === "text").map((b) => b.text).join("\n")
        if (texto) reply = texto
        const llamadas = resp.content.filter((b): b is ToolCallBlock => b.type === "tool_call")
        if (llamadas.length === 0) {
          terminado = true
          break
        }
        const resultados: ToolResultBlock[] = []
        for (const call of llamadas) {
          resultados.push(await this.ejecutar(session, call, autorizadas, nuevasPendientes, toolCalls))
        }
        session.messages.push({ role: "user", content: resultados })
        if (session.tokens >= MAX_SESSION_TOKENS) break
      }
    } catch (e) {
      session.messages.length = snapshot // se descarta el turno incompleto; la sesión sigue viva
      const msg = e instanceof Error ? e.message : String(e)
      reply = `No pude completar la respuesta: ${msg}. Las herramientas ejecutadas quedaron registradas; puedes reintentar.`
      return this.cerrar(session, reply, toolCalls, nuevasPendientes.size > 0, nuevasPendientes)
    }

    if (!terminado) {
      // Cerramos el par tool_use/tool_result con un texto para que el historial siga siendo válido.
      reply = `${reply}\n\n_Alcancé el tope de ${MAX_ITERATIONS} iteraciones o de tokens en este turno. Te muestro lo que tengo; pídeme continuar para seguir con lo pendiente._`.trim()
      session.messages.push({ role: "assistant", content: [{ type: "text", text: reply }] })
    }

    const pregunta = PREGUNTA_CONFIRMACION.test(reply)
    if (pregunta && nuevasPendientes.size === 0) this.cfg.gatedTools.forEach((t) => nuevasPendientes.add(t))
    return this.cerrar(session, reply, toolCalls, nuevasPendientes.size > 0, nuevasPendientes)
  }

  private async ejecutar(
    session: Session,
    call: ToolCallBlock,
    autorizadas: Set<string>,
    nuevasPendientes: Set<string>,
    toolCalls: ToolCallVisible[],
  ): Promise<ToolResultBlock> {
    const tool = this.registry[call.name]
    let args = { ...call.args }
    let bloqueada = false
    let content: string
    if (!tool) {
      content = JSON.stringify({ ok: false, error: `Herramienta desconocida: ${call.name}` })
    } else {
      const esControlada = this.cfg.gatedTools.includes(call.name)
      if (esControlada && args.confirmado === true && !autorizadas.has(call.name)) {
        args = { ...args, confirmado: false } // CA3: solo el usuario puede confirmar
        bloqueada = true
      }
      content = await runTool(call.name, tool, args, { directory: this.cfg.directory, sessionId: session.id })
      if (bloqueada) {
        content = JSON.stringify({
          ...(JSON.parse(content) as object),
          aviso_sistema: "confirmado=true fue ignorado: el usuario no confirmó en su último mensaje. Pide confirmación explícita y termina el turno.",
        })
      }
      const parsed = safeParse(content)
      if (esControlada && parsed && !parsed.ok) nuevasPendientes.add(call.name)
      if (esControlada && args.confirmado === true && parsed?.ok) autorizadas.delete(call.name) // la autorización se usa una sola vez
    }
    const parsed = safeParse(content)
    toolCalls.push({
      name: call.name,
      args,
      ok: parsed?.ok ?? false,
      resumen: parsed ? (parsed.ok ? JSON.stringify(parsed.data).slice(0, 600) : parsed.error) : content.slice(0, 600),
      confirmacionBloqueada: bloqueada,
    })
    return { type: "tool_result", toolCallId: call.id, content, isError: parsed ? !parsed.ok : true }
  }

  private cerrar(session: Session, reply: string, toolCalls: ToolCallVisible[], needsConfirmation: boolean, pendientes?: Set<string>): TurnResult {
    if (needsConfirmation && pendientes && pendientes.size > 0) session.pending = { tools: [...pendientes], motivo: "confirmación solicitada al usuario" }
    session.visible.push({ role: "assistant", text: reply, toolCalls, needsConfirmation, ts: new Date().toISOString() })
    return { reply, toolCalls, needsConfirmation, tokensSesion: session.tokens }
  }
}

function safeParse(s: string): ToolResult | null {
  try {
    return JSON.parse(s) as ToolResult
  } catch {
    return null
  }
}

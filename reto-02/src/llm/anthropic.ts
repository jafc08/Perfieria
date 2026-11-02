// Implementación Anthropic (Messages API) con fetch, sin SDK.
// La clave se lee solo de process.env en el backend; nunca se registra ni se devuelve.
import type { HerramientaLlm, LlmAdapter, Mensaje, RespuestaLlm, TextBlock, ToolCallBlock } from "./adapter"

type AnthropicBlock =
  | { type: "text"; text: string }
  | { type: "tool_use"; id: string; name: string; input: Record<string, unknown> }

type AnthropicResponse = {
  content: AnthropicBlock[]
  stop_reason: string
  usage: { input_tokens: number; output_tokens: number }
}

export class AnthropicAdapter implements LlmAdapter {
  readonly provider = "anthropic"
  readonly model: string
  private readonly apiKey: string
  private readonly timeoutMs: number
  private readonly maxTokens: number

  constructor(opts: { apiKey: string; model?: string; timeoutMs?: number; maxTokens?: number }) {
    this.apiKey = opts.apiKey
    this.model = opts.model ?? "claude-sonnet-5-5"
    this.timeoutMs = opts.timeoutMs ?? 90_000
    this.maxTokens = opts.maxTokens ?? 4096
  }

  async enviar(system: string, mensajes: Mensaje[], herramientas: HerramientaLlm[]): Promise<RespuestaLlm> {
    const body = {
      model: this.model,
      max_tokens: this.maxTokens,
      system,
      tools: herramientas.map((h) => ({ name: h.name, description: h.description, input_schema: h.inputSchema })),
      messages: mensajes.map(toAnthropic),
    }
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), this.timeoutMs)
    try {
      const res = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-api-key": this.apiKey,
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      })
      if (!res.ok) {
        const text = await res.text()
        throw new Error(`El proveedor LLM respondió ${res.status}: ${text.slice(0, 300)}`)
      }
      const data = (await res.json()) as AnthropicResponse
      return {
        content: data.content.map(fromAnthropic).filter((b): b is TextBlock | ToolCallBlock => b !== null),
        stopReason:
          data.stop_reason === "end_turn" ? "end_turn" : data.stop_reason === "tool_use" ? "tool_use" : data.stop_reason === "max_tokens" ? "max_tokens" : "other",
        usage: { inputTokens: data.usage.input_tokens, outputTokens: data.usage.output_tokens },
      }
    } catch (e) {
      if (e instanceof Error && e.name === "AbortError") throw new Error(`El proveedor LLM no respondió en ${this.timeoutMs / 1000} s`)
      throw e
    } finally {
      clearTimeout(timer)
    }
  }
}

function toAnthropic(m: Mensaje): { role: "user" | "assistant"; content: unknown } {
  if (m.role === "user") {
    if (typeof m.content === "string") return { role: "user", content: m.content }
    return {
      role: "user",
      content: m.content.map((r) => ({ type: "tool_result", tool_use_id: r.toolCallId, content: r.content, is_error: r.isError })),
    }
  }
  return {
    role: "assistant",
    content: m.content.map((b) => (b.type === "text" ? { type: "text", text: b.text } : { type: "tool_use", id: b.id, name: b.name, input: b.args })),
  }
}

function fromAnthropic(b: AnthropicBlock): TextBlock | ToolCallBlock | null {
  if (b.type === "text") return { type: "text", text: b.text }
  if (b.type === "tool_use") return { type: "tool_call", id: b.id, name: b.name, args: b.input }
  return null
}

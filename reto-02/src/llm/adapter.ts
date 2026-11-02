// Interfaz propia del proveedor LLM. Cambiar de proveedor = otra implementación de LlmAdapter.
// El ciclo del agente solo conoce estos tipos.

export type ToolCallBlock = { type: "tool_call"; id: string; name: string; args: Record<string, unknown> }
export type TextBlock = { type: "text"; text: string }
export type ToolResultBlock = { type: "tool_result"; toolCallId: string; content: string; isError: boolean }

export type Mensaje =
  | { role: "user"; content: string | ToolResultBlock[] }
  | { role: "assistant"; content: Array<TextBlock | ToolCallBlock> }

export type HerramientaLlm = { name: string; description: string; inputSchema: Record<string, unknown> }

export type RespuestaLlm = {
  content: Array<TextBlock | ToolCallBlock>
  stopReason: "end_turn" | "tool_use" | "max_tokens" | "other"
  usage: { inputTokens: number; outputTokens: number }
}

export interface LlmAdapter {
  readonly provider: string
  readonly model: string
  enviar(system: string, mensajes: Mensaje[], herramientas: HerramientaLlm[]): Promise<RespuestaLlm>
}

// Prueba del ciclo del agente con un LLM simulado (sin clave): verifica la confirmación forzada en backend.
import { Agent, type Session } from "../reto-01/src/agent/loop"
import { config } from "../reto-01/src/config"
import type { LlmAdapter, Mensaje, RespuestaLlm } from "../reto-01/src/llm/adapter"

// Guion: el "modelo" intenta enviar con confirmado=true en cuanto puede.
class LlmFalso implements LlmAdapter {
  provider = "falso"; model = "guion"; paso = 0
  async enviar(_s: string, mensajes: Mensaje[]): Promise<RespuestaLlm> {
    const ultimo = mensajes[mensajes.length - 1]
    const usage = { inputTokens: 10, outputTokens: 10 }
    if (ultimo.role === "user" && typeof ultimo.content === "string") {
      return { stopReason: "tool_use", usage, content: [{ type: "tool_call", id: "t" + ++this.paso, name: "proveedor_simular_envio", args: { caso: "co-industrias-delta", confirmado: true } }] }
    }
    return { stopReason: "end_turn", usage, content: [{ type: "text", text: "Listo. ¿Confirmas que envíe el paquete?" }] }
  }
}
process.env.FECHA_REFERENCIA = "2026-09-03"
const { runTool } = await import("../reto-01/src/core/tool")
const ag = new Agent(config, new LlmFalso())
const ctx = { directory: config.directory, sessionId: "t" }
for (const t of ["proveedor_mapear_campos", "proveedor_generar_formulario", "proveedor_armar_paquete"])
  await runTool(t, ag.registry[t], { caso: "co-industrias-delta", hoy: "2026-09-03" }, ctx)
const s: Session = { id: "t", messages: [], visible: [], pending: null, tokens: 0 }
const r1 = await ag.turno(s, "envía el paquete de co-industrias-delta")
console.log("T1 bloqueada:", r1.toolCalls[0].confirmacionBloqueada, "ok:", r1.toolCalls[0].ok, "needsConfirmation:", r1.needsConfirmation)
const r2 = await ag.turno(s, "sí, confirmo")
console.log("T2 bloqueada:", r2.toolCalls[0].confirmacionBloqueada, "ok:", r2.toolCalls[0].ok, r2.toolCalls[0].resumen.slice(0, 120))
const r3 = await ag.turno(s, "no, espera")
console.log("T3 (negativa) bloqueada:", r3.toolCalls[0].confirmacionBloqueada)
console.log("herramientas:", Object.keys(ag.registry).join(", "))

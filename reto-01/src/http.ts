// API HTTP del agente (independiente del reto). Se monta sola (src/server.ts) o bajo un prefijo (server.ts de la raíz).
import { existsSync, readFileSync } from "node:fs"
import { join, normalize, resolve } from "node:path"
import { randomUUID } from "node:crypto"
import { Agent, type AgentConfig, type Session } from "./agent/loop"
import { AnthropicAdapter } from "./llm/anthropic"
import type { LlmAdapter } from "./llm/adapter"

const MAX_GLOBAL_TOKENS = Number(process.env.MAX_GLOBAL_TOKENS ?? 5_000_000)
const MAX_MESSAGE_CHARS = 4000
let globalTokens = 0

export function crearLlm(): LlmAdapter | null {
  const apiKey = process.env.ANTHROPIC_API_KEY
  if (!apiKey) return null
  return new AnthropicAdapter({ apiKey, model: process.env.ANTHROPIC_MODEL })
}

const json = (data: unknown, status = 200): Response =>
  new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json; charset=utf-8" } })

export function crearApp(cfg: AgentConfig) {
  const agent = new Agent(cfg, crearLlm())
  const sessions = new Map<string, Session>()
  const html = readFileSync(join(cfg.directory, "web", "index.html"), "utf8")
    .replaceAll("{{TITULO}}", cfg.titulo)
    .replaceAll('"{{EJEMPLO}}"', JSON.stringify(cfg.ejemplo).replaceAll("<", "\\u003c"))
  const outDir = resolve(cfg.directory, "out")

  const getSession = (id: string): Session => {
    let s = sessions.get(id)
    if (!s) {
      s = { id, messages: [], visible: [], pending: null, tokens: 0 }
      sessions.set(id, s)
    }
    return s
  }

  async function handle(req: Request, path: string): Promise<Response> {
    const accessKey = process.env.ACCESS_KEY
    if (accessKey && path.startsWith("/api/") && path !== "/api/health") {
      const key = req.headers.get("x-access-key") ?? new URL(req.url).searchParams.get("key")
      if (key !== accessKey) return json({ ok: false, error: "Clave de acceso inválida" }, 401)
    }
    if (req.method === "GET" && (path === "/" || path === "")) return new Response(html, { headers: { "content-type": "text/html; charset=utf-8" } })
    if (req.method === "GET" && path === "/api/health") return json({ ok: true, reto: cfg.id, provider: agent.provider, model: agent.model, herramientas: Object.keys(agent.registry) })
    if (req.method === "GET" && path.startsWith("/api/sessions/")) {
      const s = sessions.get(decodeURIComponent(path.slice("/api/sessions/".length)))
      return s ? json({ ok: true, sessionId: s.id, tokens: s.tokens, historial: s.visible }) : json({ ok: false, error: "Sesión no encontrada" }, 404)
    }
    if (req.method === "GET" && path.startsWith("/api/out/")) {
      const rel = normalize(decodeURIComponent(path.slice("/api/out/".length)))
      const file = resolve(outDir, rel)
      if (!file.startsWith(outDir + "/") || !existsSync(file)) return json({ ok: false, error: "Archivo no encontrado" }, 404)
      return new Response(Bun.file(file))
    }
    if (req.method === "POST" && path === "/api/chat") {
      let body: { sessionId?: unknown; message?: unknown }
      try {
        body = (await req.json()) as { sessionId?: unknown; message?: unknown }
      } catch {
        return json({ ok: false, error: "Cuerpo JSON inválido" }, 400)
      }
      const message = typeof body.message === "string" ? body.message.trim() : ""
      if (!message) return json({ ok: false, error: "El mensaje está vacío" }, 400)
      if (message.length > MAX_MESSAGE_CHARS) return json({ ok: false, error: `Mensaje demasiado largo (máx. ${MAX_MESSAGE_CHARS} caracteres)` }, 400)
      if (globalTokens >= MAX_GLOBAL_TOKENS) return json({ ok: false, error: "Se alcanzó el tope global de consumo del despliegue" }, 429)
      const sessionId = typeof body.sessionId === "string" && body.sessionId ? body.sessionId.slice(0, 80) : randomUUID()
      const session = getSession(sessionId)
      const antes = session.tokens
      const result = await agent.turno(session, message)
      globalTokens += session.tokens - antes
      return json({ ok: true, sessionId, ...result })
    }
    return json({ ok: false, error: "Ruta no encontrada" }, 404)
  }

  return { cfg, agent, handle }
}

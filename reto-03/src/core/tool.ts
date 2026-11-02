// Contrato común de herramientas (idéntico en los tres retos).
// Cada herramienta: { description, args (zod), execute(args, ctx) → string JSON }.
// execute NUNCA lanza: devuelve { ok: true, data } o { ok: false, error }.
import { z } from "zod/v4"
import { appendFileSync, mkdirSync } from "node:fs"
import { dirname, join } from "node:path"

export type ToolCtx = { directory: string; sessionId: string }

export type ToolDef<S extends z.ZodRawShape = z.ZodRawShape> = {
  description: string
  args: S
  execute(args: z.infer<z.ZodObject<S>>, ctx: ToolCtx): Promise<string>
}

/** Ayuda de tipado: conserva la inferencia de args sin agregar miembros al objeto. */
export function defineTool<S extends z.ZodRawShape>(tool: ToolDef<S>): ToolDef<S> {
  return tool
}

export type ToolResult<T = unknown> = { ok: true; data: T } | { ok: false; error: string }

export const ok = (data: unknown): string => JSON.stringify({ ok: true, data })
export const fail = (error: string): string => JSON.stringify({ ok: false, error })

export function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

/** Fecha de referencia: argumento > FECHA_REFERENCIA > hoy real (YYYY-MM-DD). */
export function fechaReferencia(hoy?: string): string {
  return hoy ?? process.env.FECHA_REFERENCIA ?? new Date().toISOString().slice(0, 10)
}

/** Escribe una línea JSON (crea carpetas si hace falta). */
export function appendJsonl(path: string, record: Record<string, unknown>): void {
  mkdirSync(dirname(path), { recursive: true })
  appendFileSync(path, JSON.stringify(record) + "\n", "utf8")
}

/** Log global de llamadas a herramientas (CA4): <directory>/out/log.jsonl */
export function logToolCall(ctx: ToolCtx, herramienta: string, result: string, extra: Record<string, unknown> = {}): void {
  let okFlag = false
  let resumen = ""
  try {
    const parsed = JSON.parse(result) as ToolResult
    okFlag = parsed.ok
    resumen = parsed.ok ? JSON.stringify(parsed.data).slice(0, 300) : parsed.error
  } catch {
    resumen = result.slice(0, 300)
  }
  appendJsonl(join(ctx.directory, "out", "log.jsonl"), {
    ts: new Date().toISOString(),
    sessionId: ctx.sessionId,
    herramienta,
    ok: okFlag,
    resumen,
    ...extra,
  })
}

/** Valida args con zod y ejecuta; nunca lanza. Usado por el ciclo del agente y por demo.ts. */
export async function runTool(name: string, tool: ToolDef, rawArgs: unknown, ctx: ToolCtx): Promise<string> {
  const parsed = z.object(tool.args).safeParse(rawArgs ?? {})
  let result: string
  if (!parsed.success) {
    result = fail(`Argumentos inválidos para ${name}: ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`)
  } else {
    try {
      result = await tool.execute(parsed.data, ctx)
    } catch (e) {
      result = fail(`Error interno en ${name}: ${errorMessage(e)}`)
    }
  }
  try {
    logToolCall(ctx, name, result)
  } catch {
    /* el log nunca debe tumbar la herramienta */
  }
  return result
}

/** Convierte los exports de un módulo de herramientas a un registro <archivo>_<export>. */
export function buildRegistry(prefix: string, mod: Record<string, unknown>): Record<string, ToolDef> {
  const registry: Record<string, ToolDef> = {}
  for (const [key, value] of Object.entries(mod)) {
    if (value && typeof value === "object" && "execute" in value && "args" in value && "description" in value) {
      registry[`${prefix}_${key}`] = value as ToolDef
    }
  }
  return registry
}

export function toJsonSchema(tool: ToolDef): Record<string, unknown> {
  const schema = z.toJSONSchema(z.object(tool.args)) as Record<string, unknown>
  delete schema.$schema
  return schema
}

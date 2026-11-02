// Verificación sin modelo: procesa los 6 mensajes del buzón llamando directamente a las herramientas.
// Uso: bun run demo.ts   (no requiere clave de ningún proveedor)
import { rmSync } from "node:fs"
import { join } from "node:path"
import { buildRegistry, runTool, type ToolCtx, type ToolDef } from "./src/core/tool"
import * as contratos from "./src/tools/contratos"

const HOY = "2026-09-03"
process.env.FECHA_REFERENCIA = HOY
const ctx: ToolCtx = { directory: import.meta.dir, sessionId: "demo" }
const tools: Record<string, ToolDef> = buildRegistry("contratos", contratos)

type Resp = { ok: boolean; data?: Record<string, unknown>; error?: string }
async function call(name: string, args: Record<string, unknown>): Promise<Resp> {
  const tool = tools[name]
  if (!tool) return { ok: false, error: `herramienta inexistente ${name}` }
  return JSON.parse(await runTool(name, tool, args, ctx)) as Resp
}

rmSync(join(import.meta.dir, "out"), { recursive: true, force: true })
console.log(`== Reto 02 · demo sin modelo · fecha de referencia ${HOY} ==\n`)

const buzon = await call("contratos_leer_buzon", {})
const mensajes = (buzon.data?.mensajes as Array<{ id: string; tiene_contrato: boolean; de: string }>) ?? []
console.log(`Buzón: ${mensajes.length} mensajes pendientes\n`)

for (const m of mensajes) {
  console.log(`--- ${m.id} (de ${m.de}) ---`)
  if (m.tiene_contrato) {
    const ex = await call("contratos_extraer", { mensaje_id: m.id })
    if (!ex.ok) console.log(`  extracción: ERROR ${ex.error}`)
  }
  const val = await call("contratos_validar", { mensaje_id: m.id })
  const v = val.data ?? {}
  console.log(`  clasificación: ${String(v.clasificacion ?? val.error)}${v.id_contrato_existente ? ` (existente ${String(v.id_contrato_existente)})` : ""}`)
  const rev = (v.requiere_revision as string[] | undefined) ?? []
  if (rev.length) console.log(`  en revisión: ${rev.join(" | ")}`)
  const dif = (v.diferencias as Array<{ campo: string; antes: string; despues: string }> | undefined) ?? []
  for (const d of dif) console.log(`  cambio: ${d.campo} ${d.antes} → ${d.despues}`)
  for (const a of (v.advertencias as string[] | undefined) ?? []) console.log(`  aviso: ${a}`)
  if (v.motivo) console.log(`  motivo: ${String(v.motivo)}`)
  const reg = await call("contratos_registrar", { mensaje_id: m.id })
  console.log(reg.ok
    ? `  acción: ${String(reg.data?.accion)} ${reg.data?.id_contrato ?? ""} ${reg.data?.ruta_archivo ? `→ ${String(reg.data.ruta_archivo)}` : ""}${reg.data?.estado_poliza ? ` (póliza ${String(reg.data.estado_poliza)})` : ""}`
    : `  acción: NO REGISTRADO → ${reg.error}`)
}

console.log("\n--- Segunda pasada: confirmación humana de msg-006 ---")
const conf = await call("contratos_registrar", { mensaje_id: "msg-006", contrato: { valor: 0, fecha_fin: "2027-08-31" }, confirmado: true })
console.log(conf.ok ? `  acción: ${String(conf.data?.accion)} ${String(conf.data?.id_contrato)} → ${String(conf.data?.ruta_archivo)}` : `  ERROR ${conf.error}`)

console.log("\n--- Intento de manipulación: valor distinto sin confirmar (msg-002 ya registrado) ---")
const manip = await call("contratos_validar", { mensaje_id: "msg-002", contrato: { valor: 999 } })
console.log(`  requiere_revision: ${((manip.data?.requiere_revision as string[]) ?? []).join(" | ") || manip.error}`)

console.log("\n--- Alertas ---")
const al = await call("contratos_alertas", { hoy: HOY })
if (al.ok) {
  const d = al.data ?? {}
  const fmt = (xs: unknown) => (xs as Array<{ id_contrato: string; dias?: number; estado_poliza?: string }>).map((x) => `${x.id_contrato}${x.dias !== undefined ? ` (${x.dias} d, póliza ${x.estado_poliza})` : ""}`).join(", ") || "—"
  console.log(`  vencen ≤60 d: ${fmt(d.vencen)}`)
  console.log(`  pólizas no vigentes: ${fmt(d.polizas_pendientes)}`)
  console.log(`  registrados desde corte: ${fmt(d.registrados_desde_corte)}`)
  console.log(`  vencidos sin cierre: ${fmt(d.vencidos_sin_cierre)}`)
  console.log(`  reporte: ${String(d.ruta)}`)
} else console.log(`  ERROR ${al.error}`)

console.log("\n--- Errores controlados ---")
console.log(`  fecha inválida: ${(await call("contratos_alertas", { hoy: "2026-13-40" })).error}`)
console.log(`  mensaje inexistente: ${(await call("contratos_extraer", { mensaje_id: "msg-999" })).error}`)
console.log(`  cotización: ${(await call("contratos_extraer", { mensaje_id: "msg-005" })).error}`)

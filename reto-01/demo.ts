// demo.ts · Reto 01 — ejecuta las herramientas directamente, SIN modelo de lenguaje.
// Uso: bun run demo.ts   (desde reto-01/)
import { readdirSync, rmSync } from "node:fs"
import { join } from "node:path"
import { buildRegistry, runTool, type ToolCtx } from "./src/core/tool"
import * as proveedor from "./src/tools/proveedor"

const HOY = "2026-09-03"
const ctx: ToolCtx = { directory: import.meta.dir, sessionId: "demo" }
const tools = buildRegistry("proveedor", proveedor)

type Res = { ok: true; data: Record<string, unknown> } | { ok: false; error: string }

async function call(name: string, args: Record<string, unknown>): Promise<Res> {
  const tool = tools[name]
  if (!tool) return { ok: false, error: `herramienta inexistente ${name}` }
  return JSON.parse(await runTool(name, tool, args, ctx)) as Res
}

function lista(v: unknown): unknown[] {
  return Array.isArray(v) ? v : []
}

rmSync(join(import.meta.dir, "out"), { recursive: true, force: true })
console.log(`\n=== Reto 01 · Registro como proveedor · demo sin modelo · hoy=${HOY} ===`)

const casos = readdirSync(join(import.meta.dir, "fixtures", "reto-01", "casos")).sort()
for (const caso of casos) {
  console.log(`\n── ${caso}`)
  const sol = await call("proveedor_leer_solicitud", { caso })
  if (!sol.ok) {
    console.log(`   ERROR: ${sol.error}`)
    continue
  }
  console.log(`   país ${String(sol.data.pais)} · cliente ${String(sol.data.cliente)} · formato ${String(sol.data.formato)} · campos ${lista(sol.data.campos).length}`)
  const map = await call("proveedor_mapear_campos", { caso })
  if (map.ok) {
    const conf = lista(map.data.requiere_confirmacion) as { etiqueta: string; nota: string }[]
    const falt = lista(map.data.faltantes) as { etiqueta: string }[]
    console.log(`   llenos ${lista(map.data.llenos).length} · faltantes ${falt.length} · por confirmar ${conf.length}`)
    if (falt.length) console.log(`   faltantes: ${falt.map((f) => f.etiqueta).join("; ")}`)
    for (const c of conf) console.log(`   por confirmar: ${c.etiqueta} → ${c.nota}`)
  } else console.log(`   ERROR mapeo: ${map.error}`)
  const form = await call("proveedor_generar_formulario", { caso })
  console.log(form.ok ? `   formulario: ${String(form.data.ruta)} (${String(form.data.mensaje)})` : `   ERROR formulario: ${form.error}`)
  const paq = await call("proveedor_armar_paquete", { caso, hoy: HOY })
  if (paq.ok) {
    const ch = paq.data.checklist as { vencidos: { tipo: string }[]; ausentes: string[] }
    console.log(`   listo_para_firma: ${String(paq.data.listo_para_firma)} · vencidos [${ch.vencidos.map((v) => v.tipo).join(", ")}] · ausentes [${ch.ausentes.join(", ")}]`)
  } else console.log(`   ERROR paquete: ${paq.error}`)
}

console.log("\n── Manejo de errores")
const inexistente = await call("proveedor_leer_solicitud", { caso: "no-existe" })
console.log(`   caso inexistente → ok=${String(inexistente.ok)} · ${inexistente.ok ? "" : inexistente.error}`)
const manipulado = await call("proveedor_generar_formulario", { caso: "co-industrias-delta", mapeo: [{ etiqueta: "NIT", valor: "999999999" }] })
console.log(`   mapeo alterado por el agente → advertencias: ${manipulado.ok ? JSON.stringify(manipulado.data.advertencias) : manipulado.error}`)

console.log("\n── Confirmación humana (co-industrias-delta)")
const sinConf = await call("proveedor_simular_envio", { caso: "co-industrias-delta" })
console.log(`   sin confirmado → ok=${String(sinConf.ok)} · ${sinConf.ok ? "" : sinConf.error}`)
const conConf = await call("proveedor_simular_envio", { caso: "co-industrias-delta", confirmado: true })
console.log(`   con confirmado=true → ok=${String(conConf.ok)} · ${conConf.ok ? String(conConf.data.ruta) : conConf.error}`)
const noListo = await call("proveedor_simular_envio", { caso: "hn-agroexport-sula", confirmado: true })
console.log(`   hn-agroexport-sula con confirmado=true → ok=${String(noListo.ok)} · ${noListo.ok ? "" : noListo.error}`)
console.log("\nSalidas en reto-01/out/ · log global en out/log.jsonl · log por caso en out/<caso>/log.jsonl\n")

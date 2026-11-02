// Verificación sin modelo: ejecuta las herramientas del reto 03 sobre los 6 casos.
// Uso: bun run demo.ts   (no requiere clave de ningún proveedor)
import { rmSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { runTool, type ToolCtx, type ToolDef } from "./src/core/tool"
import * as oc from "./src/tools/oc"

const ROOT = dirname(fileURLToPath(import.meta.url))
const ctx: ToolCtx = { directory: ROOT, sessionId: "demo" }
rmSync(join(ROOT, "out"), { recursive: true, force: true })

type R = { ok: boolean; data?: Record<string, unknown>; error?: string }
const call = async (name: keyof typeof oc, args: Record<string, unknown>): Promise<R> =>
  JSON.parse(await runTool(`oc_${name}`, oc[name] as unknown as ToolDef, args, ctx)) as R

type H = { codigo: string; detalle: string }
const lista = (xs: unknown): string => {
  const arr = (xs as H[] | undefined) ?? []
  return arr.length ? arr.map((x) => `${x.codigo}`).join(", ") : "—"
}

async function procesar(caso: string, confirmado?: boolean): Promise<void> {
  const paquete = await call("leer_paquete", { caso })
  if (!paquete.ok) return console.log(`  ${caso}: ERROR leer_paquete → ${paquete.error}`)
  const v = await call("validar", { caso })
  if (!v.ok || !v.data) return console.log(`  ${caso}: ERROR validar → ${v.error}`)
  const d = v.data
  const p = await call("construir_payload", { caso })
  await call("generar_evidencia", { caso })
  const payload = p.ok && p.data ? p.data.payload : {}
  const c = await call("crear", { caso, payload, ...(confirmado !== undefined ? { confirmado } : {}) })
  console.log(
    `  ${caso}: apta=${d.apta} | bloqueos=${lista(d.bloqueos)} | confirmaciones=${lista(d.confirmaciones)} | retroactiva=${d.retroactiva}${confirmado ? " | confirmado=true" : ""}`,
  )
  const obs = (d.observaciones as H[]) ?? []
  for (const o of obs) console.log(`      obs ${o.codigo}: ${o.detalle}`)
  if (c.ok && c.data) console.log(`      → OC ${c.data.numero_oc}${c.data.idempotente ? " (idempotente: ya existía)" : ""}`)
  else console.log(`      → sin OC: ${c.error?.slice(0, 260)}`)
}

console.log("Reto 03 · Órdenes de compra SAP · demo sin modelo\n")
for (const caso of ["sol-001", "sol-002", "sol-003", "sol-004", "sol-005", "sol-006"]) await procesar(caso)

console.log("\nIdempotencia: sol-001 por segunda vez")
await procesar("sol-001")

console.log("\nConfirmación explícita del usuario para sol-004 (confirmado=true)")
await procesar("sol-004", true)

console.log("\nIntento de manipulación: payload de sol-006 con precio alterado")
const p6 = await call("construir_payload", { caso: "sol-006" })
if (p6.ok && p6.data) {
  const alterado = JSON.parse(JSON.stringify(p6.data.payload)) as { posiciones: { precio_unitario: number }[] }
  alterado.posiciones[0].precio_unitario = 1
  const r = await call("crear", { caso: "sol-006", payload: alterado, confirmado: true })
  console.log(`  → ${r.ok ? "CREADA (error de control)" : `rechazado: ${r.error}`}`)
}

console.log("\nArchivos: out/sap/ordenes.jsonl · out/control.csv · out/<caso>/{validacion,payload,trazabilidad}.json · aprobacion.{txt,pdf}")

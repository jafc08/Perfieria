// Reporte de alertas (HU-5). Fecha de referencia explícita para que sea determinista.
import { existsSync, readFileSync } from "node:fs"
import type { Fila } from "./repositorio"

export const FECHA_CORTE = "2026-05-30"
export const DIAS_ALERTA = 60

const dias = (desde: string, hasta: string): number =>
  Math.round((Date.parse(`${hasta}T00:00:00Z`) - Date.parse(`${desde}T00:00:00Z`)) / 86_400_000)

type Item = { id_contrato: string; cliente: string; fecha_fin: string; dias: number; estado_poliza: string; requiere_poliza: boolean }
type Actualizado = { id_contrato: string; fecha: string; cambios: string }

function actualizados(historialPath: string): Actualizado[] {
  if (!existsSync(historialPath)) return []
  return readFileSync(historialPath, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l) as { ts: string; id_contrato: string; accion: string; cambios: unknown })
    .filter((h) => h.accion === "actualizacion")
    .map((h) => ({
      id_contrato: h.id_contrato,
      fecha: h.ts.slice(0, 10),
      cambios: Array.isArray(h.cambios)
        ? (h.cambios as Array<{ campo: string; antes: string; despues: string }>).map((c) => `${c.campo}: ${c.antes} → ${c.despues}`).join("; ")
        : "",
    }))
}

const item = (f: Fila, hoy: string): Item => ({
  id_contrato: f.id_contrato,
  cliente: f.cliente,
  fecha_fin: f.fecha_fin,
  dias: dias(hoy, f.fecha_fin),
  estado_poliza: f.estado_poliza,
  requiere_poliza: f.requiere_poliza === "true",
})

export function generarAlertas(maestro: Fila[], hoy: string, historialPath: string) {
  const conFin = maestro.filter((f) => f.fecha_fin).map((f) => item(f, hoy))
  const vencen = conFin.filter((i) => i.dias >= 0 && i.dias <= DIAS_ALERTA).sort((a, b) => a.dias - b.dias)
  const vencidos_sin_cierre = conFin.filter((i) => i.dias < 0).sort((a, b) => a.dias - b.dias)
  const polizas_pendientes = maestro
    .filter((f) => f.requiere_poliza === "true" && f.estado_poliza !== "vigente")
    .map((f) => item(f, hoy))
  const registrados_desde_corte = maestro
    .filter((f) => f.fecha_registro >= FECHA_CORTE)
    .map((f) => ({ id_contrato: f.id_contrato, cliente: f.cliente, fecha_registro: f.fecha_registro, comercial: f.comercial }))
  const actualizados_desde_corte = actualizados(historialPath)
  const criticos = vencen.filter((v) => v.requiere_poliza && v.estado_poliza !== "vigente")

  const md: string[] = [
    `# Alertas de contratos — fecha de referencia ${hoy}`,
    "",
    criticos.length
      ? `> **Riesgo principal:** ${criticos.map((c) => `${c.id_contrato} (${c.cliente}) vence en ${c.dias} días con póliza ${c.estado_poliza}`).join("; ")}.`
      : "> Sin contratos próximos a vencer con póliza pendiente.",
    "",
    `## 1. Vencen en ≤ ${DIAS_ALERTA} días (${vencen.length})`,
    "| Contrato | Cliente | Fecha fin | Días | Póliza |",
    "|---|---|---|---|---|",
    ...vencen.map((v) => `| ${v.id_contrato} | ${v.cliente} | ${v.fecha_fin} | ${v.dias} | ${v.estado_poliza} |`),
    "",
    `## 2. Pólizas exigidas no vigentes (${polizas_pendientes.length})`,
    "| Contrato | Cliente | Estado póliza | Fecha fin |",
    "|---|---|---|---|",
    ...polizas_pendientes.map((p) => `| ${p.id_contrato} | ${p.cliente} | ${p.estado_poliza} | ${p.fecha_fin} |`),
    "",
    `## 3. Registrados desde el corte ${FECHA_CORTE} (gap cubierto: ${registrados_desde_corte.length})`,
    "| Contrato | Cliente | Fecha registro | Comercial |",
    "|---|---|---|---|",
    ...registrados_desde_corte.map((r) => `| ${r.id_contrato} | ${r.cliente} | ${r.fecha_registro} | ${r.comercial} |`),
    "",
    `### Actualizados (otrosíes) desde el corte (${actualizados_desde_corte.length})`,
    ...actualizados_desde_corte.map((a) => `- ${a.id_contrato}: ${a.cambios}`),
    "",
    `## 4. Vencidos sin acta de cierre registrada (${vencidos_sin_cierre.length})`,
    "_Siguen en el maestro de vigentes con fecha fin pasada: confirmar terminación, liquidación o prórroga._",
    "| Contrato | Cliente | Fecha fin | Días vencido | Póliza |",
    "|---|---|---|---|---|",
    ...vencidos_sin_cierre.map((v) => `| ${v.id_contrato} | ${v.cliente} | ${v.fecha_fin} | ${-v.dias} | ${v.estado_poliza} |`),
    "",
  ]
  return { markdown: md.join("\n"), vencen, polizas_pendientes, registrados_desde_corte, actualizados_desde_corte, vencidos_sin_cierre }
}

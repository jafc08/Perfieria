// Herramientas del reto 03. El modelo las ve como oc_<export>.
// Son la única fuente de valores: el modelo no calcula, no deriva ni corrige montos.
import { existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync } from "node:fs"
import { join } from "node:path"
import { PDFDocument, StandardFonts } from "pdf-lib"
import { z } from "zod/v4"
import { defineTool, errorMessage, fail, ok, type ToolCtx } from "../core/tool"
import { SapMock } from "../sap/mock"
import {
  canonico,
  cargarMaestros,
  cargarPaquete,
  construir,
  evaluar,
  sinConfirmadoPor,
  textoEvidencia,
  type Maestros,
  type Resultado,
} from "./oc-logic"
import type { OrdenCompra, Paquete, Validacion } from "./schema"

const caso = z.string().describe('Carpeta del caso en fixtures/reto-03/solicitudes/, p. ej. "sol-001"')

function outDir(ctx: ToolCtx, c: string): string {
  const d = join(ctx.directory, "out", c)
  mkdirSync(d, { recursive: true })
  return d
}

function preparar(ctx: ToolCtx, c: string): Resultado<{ m: Maestros; p: Paquete; v: Validacion }> {
  let m: Maestros
  try {
    m = cargarMaestros(ctx.directory)
  } catch (e) {
    return { ok: false, error: `No se pudieron leer los maestros: ${errorMessage(e)}` }
  }
  const p = cargarPaquete(ctx.directory, c)
  if (!p.ok) return p
  return { ok: true, data: { m, p: p.data, v: evaluar(m, p.data) } }
}

// ---------- control.csv (HU-5) ----------
const CONTROL_HEADER = "solicitud_id,resultado,numero_oc,retroactiva,bloqueos,confirmaciones,ts\n"
const csv = (v: string): string => (/[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v)

function registrarControl(
  ctx: ToolCtx,
  fila: { solicitud_id: string; resultado: string; numero_oc: string; retroactiva: boolean; bloqueos: string[]; confirmaciones: string[] },
): void {
  const ruta = join(ctx.directory, "out", "control.csv")
  mkdirSync(join(ctx.directory, "out"), { recursive: true })
  if (!existsSync(ruta)) writeFileSync(ruta, CONTROL_HEADER, "utf8")
  const linea = [
    fila.solicitud_id,
    fila.resultado,
    fila.numero_oc,
    String(fila.retroactiva),
    fila.bloqueos.join("|"),
    fila.confirmaciones.join("|"),
    new Date().toISOString(),
  ]
    .map(csv)
    .join(",")
  appendFileSync(ruta, linea + "\n", "utf8")
}

// ---------- evidencia ----------
async function escribirEvidencia(ctx: ToolCtx, c: string): Promise<Resultado<{ ruta: string; ruta_pdf: string | null; sha256: string; aviso?: string }>> {
  const ev = textoEvidencia(c, ctx.directory)
  if (!ev.ok) return ev
  const dir = outDir(ctx, c)
  const ruta = join(dir, "aprobacion.txt")
  writeFileSync(ruta, `${ev.data.contenido}\nsha256: ${ev.data.sha256}\n`, "utf8")
  try {
    const pdf = await PDFDocument.create()
    const font = await pdf.embedFont(StandardFonts.Helvetica)
    let page = pdf.addPage([595, 842])
    let y = 800
    const lineas = [`Evidencia de aprobación · caso ${c}`, "", ...ev.data.contenido.split("\n"), "", `sha256: ${ev.data.sha256}`]
    for (const bruta of lineas) {
      const partes = bruta.match(/.{1,90}(\s|$)|.{1,90}/g) ?? [""]
      for (const l of partes) {
        if (y < 50) {
          page = pdf.addPage([595, 842])
          y = 800
        }
        page.drawText(l.trimEnd(), { x: 50, y, size: 10, font })
        y -= 14
      }
    }
    const rutaPdf = join(dir, "aprobacion.pdf")
    writeFileSync(rutaPdf, await pdf.save({ useObjectStreams: false }))
    return { ok: true, data: { ruta: `out/${c}/aprobacion.txt`, ruta_pdf: `out/${c}/aprobacion.pdf`, sha256: ev.data.sha256 } }
  } catch (e) {
    return { ok: true, data: { ruta: `out/${c}/aprobacion.txt`, ruta_pdf: null, sha256: ev.data.sha256, aviso: `PDF no generado: ${errorMessage(e)}` } }
  }
}

// =================== herramientas ===================

export const leer_paquete = defineTool({
  description: "Lee el correo, la solicitud, la cotización, la aprobación y la factura (si existe) de un caso y los devuelve normalizados.",
  args: { caso },
  async execute(args, ctx) {
    const p = cargarPaquete(ctx.directory, args.caso)
    if (!p.ok) return fail(p.error)
    const { cotizacion, ...resto } = p.data
    // el texto completo de la cotización no se reenvía al modelo: basta con los campos extraídos
    return ok({ ...resto, cotizacion: cotizacion ? { ...cotizacion, texto: `${cotizacion.texto.slice(0, 120)}…` } : null })
  },
})

export const validar = defineTool({
  description: "Aplica los controles RC1–RC10 contra los maestros y devuelve si la OC es apta, sus bloqueos, confirmaciones, valores derivados y si es retroactiva.",
  args: {
    caso,
    paquete: z.unknown().optional().describe("Opcional e ignorado: el paquete se relee del caso para que nadie pueda alterarlo"),
  },
  async execute(args, ctx) {
    const r = preparar(ctx, args.caso)
    if (!r.ok) return fail(r.error)
    const { v } = r.data
    writeFileSync(join(outDir(ctx, args.caso), "validacion.json"), JSON.stringify(v, null, 2), "utf8")
    return ok(v)
  },
})

export const construir_payload = defineTool({
  description: "Construye la orden de compra exactamente como quedaría en SAP, valida su esquema y guarda la trazabilidad de cada valor.",
  args: {
    caso,
    paquete: z.unknown().optional().describe("Opcional e ignorado: se relee del caso"),
    derivados: z.unknown().optional().describe("Opcional e ignorado: los derivados se recalculan desde los maestros"),
  },
  async execute(args, ctx) {
    const r = preparar(ctx, args.caso)
    if (!r.ok) return fail(r.error)
    const { m, p, v } = r.data
    const b = construir(ctx.directory, args.caso, m, p, v)
    if (!b.ok) return fail(b.error)
    const dir = outDir(ctx, args.caso)
    writeFileSync(join(dir, "trazabilidad.json"), JSON.stringify(b.data.trazabilidad, null, 2), "utf8")
    writeFileSync(join(dir, "payload.json"), JSON.stringify(b.data.payload, null, 2), "utf8")
    return ok({
      payload: b.data.payload,
      resumen: b.data.resumen,
      confirmaciones_pendientes: v.confirmaciones,
      observaciones: v.observaciones,
      ruta_trazabilidad: `out/${args.caso}/trazabilidad.json`,
    })
  },
})

export const generar_evidencia = defineTool({
  description: "Genera la evidencia del correo de aprobación (aprobacion.txt con sha256 y aprobacion.pdf) para adjuntar a la OC.",
  args: { caso },
  async execute(args, ctx) {
    const r = await escribirEvidencia(ctx, args.caso)
    return r.ok ? ok(r.data) : fail(r.error)
  },
})

export const crear = defineTool({
  description: "Crea la OC en el SAP simulado si es apta; exige confirmado=true cuando hay confirmaciones y devuelve el número existente si ya se creó.",
  args: {
    caso,
    payload: z.unknown().describe("El payload devuelto por oc_construir_payload, sin modificaciones"),
    confirmado: z.boolean().optional().describe("true solo si el usuario confirmó explícitamente las excepciones en su último mensaje"),
  },
  async execute(args, ctx) {
    const r = preparar(ctx, args.caso)
    if (!r.ok) return fail(r.error)
    const { m, p, v } = r.data
    const sid = p.solicitud.solicitud_id
    const base = {
      solicitud_id: sid,
      retroactiva: v.retroactiva,
      bloqueos: v.bloqueos.map((b) => b.codigo),
      confirmaciones: v.confirmaciones.map((c) => c.codigo),
    }
    const sap = new SapMock(ctx.directory)

    // 1. Idempotencia: misma solicitud → mismo número
    const existente = await sap.buscarOrdenPorReferencia(sid)
    if (existente) {
      registrarControl(ctx, { ...base, resultado: "idempotente", numero_oc: existente.numero_oc })
      return ok({ numero_oc: existente.numero_oc, fecha: sap.fechaDe(sid), idempotente: true, retroactiva: v.retroactiva })
    }

    // 2. Bloqueos
    if (!v.apta) {
      registrarControl(ctx, { ...base, resultado: "bloqueada", numero_oc: "" })
      return fail(
        `OC bloqueada: ${v.bloqueos.map((b) => `${b.codigo}: ${b.detalle}${b.accion_sugerida ? ` → ${b.accion_sugerida}` : ""}`).join(" | ")}`,
      )
    }

    // 3. Anti-manipulación: el payload recibido debe ser idéntico al reconstruido en el servidor
    const b = construir(ctx.directory, args.caso, m, p, v)
    if (!b.ok) return fail(b.error)
    if (canonico(sinConfirmadoPor(args.payload)) !== canonico(sinConfirmadoPor(b.data.payload))) {
      registrarControl(ctx, { ...base, resultado: "rechazada_payload_alterado", numero_oc: "" })
      return fail("El payload no coincide con el validado; reconstrúyelo con oc_construir_payload y envíalo sin cambios.")
    }

    // 4. Confirmaciones
    if (v.confirmaciones.length > 0 && args.confirmado !== true) {
      registrarControl(ctx, { ...base, resultado: "pendiente_confirmacion", numero_oc: "" })
      return fail(
        `Requiere confirmación explícita del usuario antes de crear: ${v.confirmaciones.map((c) => `${c.codigo}: ${c.detalle}`).join(" | ")}`,
      )
    }

    // 5. Crear
    const codigosConfirmados = new Set(v.confirmaciones.map((c) => c.codigo))
    const orden: OrdenCompra = {
      ...b.data.payload,
      excepciones: b.data.payload.excepciones.map((e) => ({
        ...e,
        confirmado_por: args.confirmado === true && codigosConfirmados.has(e.codigo) ? "analista (chat)" : e.confirmado_por,
      })),
    }
    const ev = await escribirEvidencia(ctx, args.caso)
    const creada = await sap.crearOrden(orden)
    writeFileSync(join(outDir(ctx, args.caso), "oc.json"), JSON.stringify({ ...creada, orden }, null, 2), "utf8")
    registrarControl(ctx, { ...base, resultado: "creada", numero_oc: creada.numero_oc })
    return ok({
      numero_oc: creada.numero_oc,
      fecha: creada.fecha,
      idempotente: false,
      retroactiva: v.retroactiva,
      evidencia: ev.ok ? ev.data : null,
    })
  },
})

/** Lectura del log de control para el chat (útil para auditoría). */
export const leer_control = defineTool({
  description: "Devuelve las filas del log de control out/control.csv (intentos de creación, bloqueos, confirmaciones y retroactivas).",
  args: {},
  async execute(_args, ctx) {
    const ruta = join(ctx.directory, "out", "control.csv")
    if (!existsSync(ruta)) return ok({ filas: [], nota: "Aún no hay intentos registrados." })
    const [enc, ...filas] = readFileSync(ruta, "utf8").trim().split("\n")
    return ok({ encabezado: enc, filas })
  },
})

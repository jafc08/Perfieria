// Herramientas del Reto 01 · Registro como proveedor.
// Cada export es una herramienta; el modelo la ve como proveedor_<export>.
// Regla de oro: los valores salen del maestro (fixtures), nunca del modelo.
import { z } from "zod/v4"
import { createHash } from "node:crypto"
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import JSZip from "jszip"
import { PDFDocument, StandardFonts, rgb } from "pdf-lib"
import { appendJsonl, defineTool, errorMessage, fail, fechaReferencia, ok, type ToolCtx } from "../core/tool"

// ───────────────────────── Tipos ─────────────────────────

type Formato = "xlsx" | "pdf" | "portal"
type Solicitud = {
  id: string
  de: string
  para?: string
  asunto: string
  fecha: string
  pais: string
  cliente: string
  formato: Formato
  cuerpo: string
  adjuntos: string[]
}
type PlantillaCelda = { hoja: string; celda_etiqueta: string; etiqueta: string; celda_valor: string }
type PlantillaCampo = { etiqueta: string; obligatorio: boolean }
type Campo = { etiqueta: string; obligatorio: boolean; hoja?: string; celda_etiqueta?: string; celda_valor?: string }
type Soporte = { tipo: string; archivo: string; vigencia_hasta: string | null; pais_emisor: string; descripcion: string }
type Estado = "lleno" | "faltante" | "requiere_confirmacion"
type Entrada = {
  etiqueta: string
  estado: Estado
  clave: string | null
  valor: string | null
  confianza: number
  nota: string | null
}
type Mapeo = { caso: string; pais: string; entradas: Entrada[]; sha256: string }

const ID_TRIBUTARIO: Record<string, string> = { CO: "NIT", EC: "RUC", PE: "RUC", PA: "RUC", HN: "RTN" }
const ETIQUETAS_AMBIGUAS = new Set(["identificacion tributaria"])
const STOPWORDS = new Set(["de", "del", "la", "el", "los", "las", "o", "y", "e", "/", "-", "en", "para"])
const MONEDA_CLAVES: Record<string, string> = { "ingresos_ultimo_ano.valor": "ingresos_ultimo_ano.moneda" }

// ───────────────────────── Utilidades ─────────────────────────

const FIXTURES = ["fixtures", "reto-01"]

function casoValido(caso: string): boolean {
  return /^[a-z0-9][a-z0-9-]*$/.test(caso)
}
function casoDir(ctx: ToolCtx, caso: string): string {
  return join(ctx.directory, ...FIXTURES, "casos", caso)
}
function outDir(ctx: ToolCtx, caso: string): string {
  return join(ctx.directory, "out", caso)
}
function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, "utf8")) as T
}
function sha256(text: string | Uint8Array): string {
  return createHash("sha256").update(text).digest("hex")
}
function normalizar(s: string): string {
  return s
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9/ ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
}
function tokens(s: string): Set<string> {
  return new Set(normalizar(s).split(" ").filter((t) => t && !STOPWORDS.has(t)))
}
function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0
  let inter = 0
  for (const t of a) if (b.has(t)) inter++
  return inter / (a.size + b.size - inter)
}
function resolverRuta(obj: unknown, ruta: string): unknown {
  let actual: unknown = obj
  for (const parte of ruta.split(".")) {
    if (actual && typeof actual === "object" && parte in actual) {
      actual = (actual as Record<string, unknown>)[parte]
    } else {
      return undefined
    }
  }
  return actual
}
function aTexto(v: unknown): string | null {
  if (v === undefined || v === null) return null
  if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") return String(v)
  return null // objetos/arrays no se aplanan: evita "inventar" un formato
}

/** RN5: log por caso. Solo escribe si el caso existe en fixtures. */
function logCaso(ctx: ToolCtx, caso: string, herramienta: string, okFlag: boolean, resumen: string): void {
  try {
    if (!casoValido(caso) || !existsSync(casoDir(ctx, caso))) return
    appendJsonl(join(outDir(ctx, caso), "log.jsonl"), { ts: new Date().toISOString(), herramienta, ok: okFlag, resumen })
  } catch {
    /* el log no debe romper la herramienta */
  }
}

/** Envuelve la ejecución: nunca lanza y deja log por caso. */
async function ejecutar(ctx: ToolCtx, caso: string, herramienta: string, fn: () => Promise<{ data: unknown; resumen: string }>): Promise<string> {
  try {
    if (!casoValido(caso)) {
      return fail(`Nombre de caso inválido: "${caso}". Usa el nombre de la carpeta, por ejemplo "co-industrias-delta".`)
    }
    if (!existsSync(casoDir(ctx, caso))) {
      return fail(`El caso "${caso}" no existe en fixtures/reto-01/casos/. Casos disponibles: ${listarCasos(ctx).join(", ") || "ninguno"}.`)
    }
    const { data, resumen } = await fn()
    logCaso(ctx, caso, herramienta, true, resumen)
    return ok(data)
  } catch (e) {
    const msg = errorMessage(e)
    logCaso(ctx, caso, herramienta, false, msg)
    return fail(msg)
  }
}

function listarCasos(ctx: ToolCtx): string[] {
  try {
    const dir = join(ctx.directory, ...FIXTURES, "casos")
    return existsSync(dir) ? readdirSync(dir).sort() : []
  } catch {
    return []
  }
}

// ───────────────────────── Lectura ─────────────────────────

type SolicitudLeida = {
  solicitud: Solicitud
  campos: Campo[]
  soportes: string[]
  advertencias: string[]
}

function leerCaso(ctx: ToolCtx, caso: string): SolicitudLeida {
  const dir = casoDir(ctx, caso)
  const solicitud = readJson<Solicitud>(join(dir, "solicitud.json"))
  const advertencias: string[] = []
  let campos: Campo[] = []
  const rutaCeldas = join(dir, "plantilla-celdas.json")
  const rutaCampos = join(dir, "plantilla-campos.json")
  try {
    if (existsSync(rutaCeldas)) {
      const celdas = readJson<PlantillaCelda[]>(rutaCeldas)
      if (!Array.isArray(celdas)) throw new Error("no es una lista")
      campos = celdas.map((c) => ({ etiqueta: c.etiqueta, obligatorio: true, hoja: c.hoja, celda_etiqueta: c.celda_etiqueta, celda_valor: c.celda_valor }))
    } else if (existsSync(rutaCampos)) {
      const lista = readJson<PlantillaCampo[]>(rutaCampos)
      if (!Array.isArray(lista)) throw new Error("no es una lista")
      campos = lista.map((c) => ({ etiqueta: c.etiqueta, obligatorio: c.obligatorio }))
    } else {
      advertencias.push("El caso no trae plantilla de campos ni de celdas.")
    }
  } catch (e) {
    advertencias.push(`Plantilla corrupta o ilegible (${errorMessage(e)}). Se continúa sin campos.`)
    campos = []
  }
  let soportes: string[] = []
  try {
    soportes = readJson<string[]>(join(dir, "soportes-exigidos.json"))
  } catch {
    advertencias.push("No se pudo leer soportes-exigidos.json; se asume lista vacía.")
  }
  if (solicitud.formato === "xlsx" && !existsSync(rutaCeldas)) advertencias.push("Formato xlsx sin plantilla-celdas.json.")
  return { solicitud, campos, soportes, advertencias }
}

// ───────────────────────── Mapeo ─────────────────────────

function cargarGlosario(ctx: ToolCtx): Map<string, string> {
  const glosario = readJson<Record<string, string>>(join(ctx.directory, ...FIXTURES, "glosario-campos.json"))
  const m = new Map<string, string>()
  for (const [etiqueta, clave] of Object.entries(glosario)) m.set(normalizar(etiqueta), clave)
  return m
}
function cargarMaestro(ctx: ToolCtx): Record<string, unknown> {
  return readJson<Record<string, unknown>>(join(ctx.directory, ...FIXTURES, "repositorio", "maestro.json"))
}

function mapearEtiqueta(etiqueta: string, pais: string, glosario: Map<string, string>, maestro: Record<string, unknown>): Entrada {
  const norm = normalizar(etiqueta)
  let clave = glosario.get(norm) ?? null
  let confianza = clave ? 1 : 0
  let sugerencia: string | null = null

  if (!clave) {
    // Similitud solo como sugerencia: nunca reemplaza al glosario.
    const tk = tokens(etiqueta)
    let mejor = { etiqueta: "", clave: "", score: 0 }
    for (const [g, c] of glosario) {
      const score = jaccard(tk, tokens(g))
      if (score > mejor.score) mejor = { etiqueta: g, clave: c, score }
    }
    if (mejor.score >= 0.8) {
      clave = mejor.clave
      confianza = Number(mejor.score.toFixed(2))
    } else if (mejor.score >= 0.5) {
      sugerencia = mejor.clave
      confianza = Number(mejor.score.toFixed(2))
    }
  }

  if (!clave && sugerencia) {
    const valor = aTexto(resolverRuta(maestro, sugerencia))
    return {
      etiqueta,
      estado: "requiere_confirmacion",
      clave: sugerencia,
      valor,
      confianza,
      nota: `Mapeo por similitud (${confianza}) con "${sugerencia}". Confirmar que corresponde.`,
    }
  }
  if (!clave) {
    return { etiqueta, estado: "faltante", clave: null, valor: null, confianza: 0, nota: "Sin equivalente en el glosario ni en el maestro." }
  }

  const valor = aTexto(resolverRuta(maestro, clave))
  if (valor === null) {
    return { etiqueta, estado: "faltante", clave, valor: null, confianza, nota: `La clave "${clave}" no tiene valor en el maestro.` }
  }

  // RN1 y HU-1: identificador tributario por país.
  if (clave === "nit") {
    const esperado = ID_TRIBUTARIO[pais] ?? "identificador tributario"
    if (ETIQUETAS_AMBIGUAS.has(norm)) {
      return {
        etiqueta,
        estado: "requiere_confirmacion",
        clave,
        valor,
        confianza: 0.7,
        nota: `Etiqueta ambigua. Para ${pais} el equivalente es ${esperado}.${pais !== "CO" ? " Periferia solo tiene NIT colombiano (identificador extranjero)." : ""}`,
      }
    }
    if (pais !== "CO") {
      return {
        etiqueta,
        estado: "requiere_confirmacion",
        clave,
        valor,
        confianza: 0.7,
        nota: `identificador extranjero: el cliente pide ${esperado}; Periferia solo tiene NIT colombiano.`,
      }
    }
  }

  const claveMoneda = MONEDA_CLAVES[clave]
  const nota = claveMoneda ? `moneda ${aTexto(resolverRuta(maestro, claveMoneda)) ?? "no indicada"}` : null
  return { etiqueta, estado: "lleno", clave, valor, confianza, nota }
}

function calcularMapeo(ctx: ToolCtx, caso: string, etiquetas?: string[]): Mapeo {
  const { solicitud, campos } = leerCaso(ctx, caso)
  const glosario = cargarGlosario(ctx)
  const maestro = cargarMaestro(ctx)
  const lista = etiquetas && etiquetas.length > 0 ? etiquetas : campos.map((c) => c.etiqueta)
  const entradas = lista.map((e) => mapearEtiqueta(e, solicitud.pais, glosario, maestro))
  const hash = sha256(JSON.stringify(entradas))
  return { caso, pais: solicitud.pais, entradas, sha256: hash }
}

function guardarMapeo(ctx: ToolCtx, mapeo: Mapeo): string {
  const dir = outDir(ctx, mapeo.caso)
  mkdirSync(dir, { recursive: true })
  const ruta = join(dir, "mapeo.json")
  writeFileSync(ruta, JSON.stringify(mapeo, null, 2), "utf8")
  return ruta
}

/** Lee el mapeo del servidor; si no existe o fue alterado en disco, lo recalcula. */
function obtenerMapeoServidor(ctx: ToolCtx, caso: string): Mapeo {
  const ruta = join(outDir(ctx, caso), "mapeo.json")
  if (existsSync(ruta)) {
    const guardado = readJson<Mapeo>(ruta)
    if (sha256(JSON.stringify(guardado.entradas)) === guardado.sha256) return guardado
  }
  const nuevo = calcularMapeo(ctx, caso)
  guardarMapeo(ctx, nuevo)
  return nuevo
}

function resumenMapeo(m: Mapeo) {
  return {
    llenos: m.entradas.filter((e) => e.estado === "lleno").map((e) => ({ etiqueta: e.etiqueta, valor: e.valor, ruta_maestro: e.clave, confianza: e.confianza, nota: e.nota })),
    faltantes: m.entradas.filter((e) => e.estado === "faltante").map((e) => ({ etiqueta: e.etiqueta, motivo: e.nota })),
    requiere_confirmacion: m.entradas
      .filter((e) => e.estado === "requiere_confirmacion")
      .map((e) => ({ etiqueta: e.etiqueta, valor_propuesto: e.valor, ruta_maestro: e.clave, confianza: e.confianza, nota: e.nota })),
  }
}

function valorParaFormulario(e: Entrada): string {
  if (e.estado === "faltante") return "[FALTANTE]"
  if (e.estado === "requiere_confirmacion") return `[POR CONFIRMAR] ${e.valor ?? ""}`.trim()
  // Si el dato tiene moneda en el maestro, se escribe junto al valor (nunca se convierte).
  if (e.nota?.startsWith("moneda ")) return `${e.valor ?? ""} ${e.nota.slice(7)}`.trim()
  return e.valor ?? ""
}

// ───────────────────────── Generación de archivos ─────────────────────────

function xmlEscape(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;")
}
function celdaAIndices(ref: string): { fila: number; col: number } {
  const m = /^([A-Z]+)(\d+)$/.exec(ref.toUpperCase())
  if (!m) throw new Error(`Referencia de celda inválida: ${ref}`)
  let col = 0
  for (const ch of m[1]) col = col * 26 + (ch.charCodeAt(0) - 64)
  return { fila: Number(m[2]), col }
}

async function generarXlsx(campos: Campo[], entradas: Entrada[], ruta: string): Promise<void> {
  const porEtiqueta = new Map(entradas.map((e) => [e.etiqueta, e]))
  const hojas = new Map<string, Map<string, string>>() // hoja → (ref → texto)
  for (const c of campos) {
    if (!c.hoja || !c.celda_etiqueta || !c.celda_valor) continue
    const celdas = hojas.get(c.hoja) ?? new Map<string, string>()
    const e = porEtiqueta.get(c.etiqueta)
    celdas.set(c.celda_etiqueta.toUpperCase(), c.etiqueta)
    celdas.set(c.celda_valor.toUpperCase(), e ? valorParaFormulario(e) : "[FALTANTE]")
    hojas.set(c.hoja, celdas)
  }
  if (hojas.size === 0) throw new Error("La plantilla no define celdas para escribir.")

  const zip = new JSZip()
  const fecha = new Date("2026-01-01T00:00:00Z") // fecha fija: salida determinista
  const nombres = [...hojas.keys()]
  const overrides = nombres
    .map((_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`)
    .join("")
  zip.file(
    "[Content_Types].xml",
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>${overrides}</Types>`,
    { date: fecha },
  )
  zip.file(
    "_rels/.rels",
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`,
    { date: fecha },
  )
  const sheetsXml = nombres.map((n, i) => `<sheet name="${xmlEscape(n.slice(0, 31))}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join("")
  zip.file(
    "xl/workbook.xml",
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>${sheetsXml}</sheets></workbook>`,
    { date: fecha },
  )
  const rels = nombres
    .map((_, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`)
    .join("")
  zip.file(
    "xl/_rels/workbook.xml.rels",
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${rels}</Relationships>`,
    { date: fecha },
  )
  nombres.forEach((nombre, i) => {
    const celdas = hojas.get(nombre) ?? new Map<string, string>()
    const filas = new Map<number, { col: number; ref: string; texto: string }[]>()
    for (const [ref, texto] of celdas) {
      const { fila, col } = celdaAIndices(ref)
      const lista = filas.get(fila) ?? []
      lista.push({ col, ref, texto })
      filas.set(fila, lista)
    }
    const filasXml = [...filas.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([fila, cs]) => {
        const cells = cs
          .sort((a, b) => a.col - b.col)
          .map((c) => `<c r="${c.ref}" t="inlineStr"><is><t xml:space="preserve">${xmlEscape(c.texto)}</t></is></c>`)
          .join("")
        return `<row r="${fila}">${cells}</row>`
      })
      .join("")
    zip.file(
      `xl/worksheets/sheet${i + 1}.xml`,
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><cols><col min="1" max="3" width="45" customWidth="1"/></cols><sheetData>${filasXml}</sheetData></worksheet>`,
      { date: fecha },
    )
  })
  const buf = await zip.generateAsync({ type: "uint8array", compression: "DEFLATE" })
  writeFileSync(ruta, buf)
}

function partirLinea(texto: string, max: number): string[] {
  const palabras = texto.split(/\s+/)
  const lineas: string[] = []
  let actual = ""
  for (const p of palabras) {
    if ((actual + " " + p).trim().length > max) {
      if (actual) lineas.push(actual)
      actual = p
    } else {
      actual = (actual + " " + p).trim()
    }
  }
  if (actual) lineas.push(actual)
  return lineas.length ? lineas : [""]
}

async function generarPdf(solicitud: Solicitud, campos: Campo[], entradas: Entrada[], ruta: string): Promise<void> {
  const porEtiqueta = new Map(entradas.map((e) => [e.etiqueta, e]))
  const pdf = await PDFDocument.create()
  pdf.setCreationDate(new Date("2026-01-01T00:00:00Z"))
  pdf.setModificationDate(new Date("2026-01-01T00:00:00Z"))
  pdf.setTitle(`Formulario de proveedor - ${solicitud.cliente}`)
  pdf.setProducer("Agente Registro como Proveedor")
  const font = await pdf.embedFont(StandardFonts.Helvetica)
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold)
  let page = pdf.addPage([595, 842])
  let y = 800
  const nuevaLinea = (alto: number) => {
    y -= alto
    if (y < 60) {
      page = pdf.addPage([595, 842])
      y = 800
    }
  }
  page.drawText(`Formulario de calificación de proveedor - ${solicitud.cliente}`, { x: 50, y, size: 13, font: bold })
  nuevaLinea(18)
  page.drawText(`Proveedor: Periferia IT Group S.A.S. · Solicitud ${solicitud.id} (${solicitud.fecha})`, { x: 50, y, size: 9, font, color: rgb(0.3, 0.3, 0.3) })
  nuevaLinea(24)
  for (const c of campos) {
    const e = porEtiqueta.get(c.etiqueta)
    const valor = e ? valorParaFormulario(e) : "[FALTANTE]"
    page.drawText(`${c.etiqueta}${c.obligatorio ? " *" : ""}:`, { x: 50, y, size: 10, font: bold })
    const lineas = partirLinea(valor, 60)
    lineas.forEach((l, i) => {
      page.drawText(l, { x: 260, y: y - i * 13, size: 10, font, color: e?.estado === "lleno" ? rgb(0, 0, 0) : rgb(0.7, 0.1, 0.1) })
    })
    nuevaLinea(13 * lineas.length + 6)
  }
  nuevaLinea(20)
  page.drawText("* obligatorio. Firma del representante legal: ______________________________", { x: 50, y, size: 9, font })
  const bytes = await pdf.save()
  writeFileSync(ruta, bytes)
}

function generarValoresPortal(solicitud: Solicitud, campos: Campo[], entradas: Entrada[], ruta: string): void {
  const porEtiqueta = new Map(entradas.map((e) => [e.etiqueta, e]))
  const filas = campos.map((c) => {
    const e = porEtiqueta.get(c.etiqueta)
    const estado = e?.estado ?? "faltante"
    return `| ${c.etiqueta} | ${e?.valor ?? ""} | ${estado}${e?.nota ? ` — ${e.nota}` : ""} |`
  })
  const md = [
    `# Valores para portal · ${solicitud.cliente}`,
    "",
    "> Formato no soportado para llenado automático (portal web con usuario y contraseña).",
    "> Una persona ingresa las credenciales, pega estos valores y hace clic en **Enviar**.",
    "",
    "| Campo del portal | Valor para copiar | Estado |",
    "|---|---|---|",
    ...filas,
    "",
  ].join("\n")
  writeFileSync(ruta, md, "utf8")
}

type FormularioGenerado = { ruta: string; formato: Formato; soportado: boolean; mensaje: string; advertencias: string[] }

async function generarFormularioInterno(ctx: ToolCtx, caso: string, mapeoModelo?: { etiqueta: string; valor?: string | null }[]): Promise<FormularioGenerado> {
  const { solicitud, campos, advertencias } = leerCaso(ctx, caso)
  const mapeo = obtenerMapeoServidor(ctx, caso)
  const adv = [...advertencias]
  // Anti-manipulación: el mapeo del modelo nunca se usa; solo se compara.
  if (mapeoModelo) {
    const servidor = new Map(mapeo.entradas.map((e) => [e.etiqueta, e.valor]))
    for (const m of mapeoModelo) {
      if (m.valor === undefined) continue
      if (!servidor.has(m.etiqueta)) adv.push(`Etiqueta "${m.etiqueta}" enviada por el agente no está en la plantilla: ignorada.`)
      else if ((servidor.get(m.etiqueta) ?? null) !== (m.valor ?? null)) adv.push(`Valor de "${m.etiqueta}" enviado por el agente difiere del maestro: se usó el valor del maestro.`)
    }
  }
  const dir = outDir(ctx, caso)
  mkdirSync(dir, { recursive: true })
  if (solicitud.formato === "xlsx") {
    const ruta = join(dir, "formulario.xlsx")
    await generarXlsx(campos, mapeo.entradas, ruta)
    return { ruta: rel(ctx, ruta), formato: "xlsx", soportado: true, mensaje: "Formulario Excel generado en las celdas de la plantilla.", advertencias: adv }
  }
  if (solicitud.formato === "pdf") {
    const ruta = join(dir, "formulario.pdf")
    await generarPdf(solicitud, campos, mapeo.entradas, ruta)
    return { ruta: rel(ctx, ruta), formato: "pdf", soportado: true, mensaje: "Formulario PDF generado (PDF nuevo, no AcroForm).", advertencias: adv }
  }
  if (solicitud.formato === "portal") {
    const ruta = join(dir, "valores-portal.md")
    generarValoresPortal(solicitud, campos, mapeo.entradas, ruta)
    return {
      ruta: rel(ctx, ruta),
      formato: "portal",
      soportado: false,
      mensaje: "formato no soportado: portal web. Se generaron los valores listos para copiar; el ingreso de credenciales y el envío son humanos.",
      advertencias: adv,
    }
  }
  throw new Error(`formato no soportado: "${String(solicitud.formato)}"`)
}

function rel(ctx: ToolCtx, ruta: string): string {
  return ruta.startsWith(ctx.directory) ? ruta.slice(ctx.directory.length + 1) : ruta
}

// ───────────────────────── Herramientas ─────────────────────────

export const leer_solicitud = defineTool({
  description: "Lee la solicitud de registro de un caso y devuelve país, cliente, formato de salida, campos pedidos y soportes exigidos.",
  args: {
    caso: z.string().describe("Nombre de la carpeta del caso en fixtures/reto-01/casos/, por ejemplo co-industrias-delta"),
  },
  async execute(args, ctx) {
    return ejecutar(ctx, args.caso, "leer_solicitud", async () => {
      const { solicitud, campos, soportes, advertencias } = leerCaso(ctx, args.caso)
      const ambiguos = campos
        .filter((c) => ETIQUETAS_AMBIGUAS.has(normalizar(c.etiqueta)))
        .map((c) => ({ etiqueta: c.etiqueta, estado: "requiere_confirmacion", propuesta: ID_TRIBUTARIO[solicitud.pais] ?? "identificador tributario" }))
      const data = {
        caso: args.caso,
        pais: solicitud.pais,
        cliente: solicitud.cliente,
        formato: solicitud.formato,
        remitente: solicitud.de,
        asunto: solicitud.asunto,
        fecha: solicitud.fecha,
        identificador_tributario_pais: ID_TRIBUTARIO[solicitud.pais] ?? null,
        campos: campos.map((c) => ({ etiqueta: c.etiqueta, obligatorio: c.obligatorio, ...(c.hoja ? { hoja: c.hoja, celda_valor: c.celda_valor } : {}) })),
        soportes,
        ambiguos,
        advertencias,
      }
      return { data, resumen: `${solicitud.formato} · ${campos.length} campos · ${soportes.length} soportes` }
    })
  },
})

export const mapear_campos = defineTool({
  description: "Cruza cada campo pedido con el repositorio maestro y lo clasifica como lleno, faltante o requiere_confirmacion, sin inventar valores.",
  args: {
    caso: z.string().describe("Nombre de la carpeta del caso"),
    campos: z.array(z.string()).optional().describe("Etiquetas a mapear; si se omite se usan todas las de la plantilla del caso"),
  },
  async execute(args, ctx) {
    return ejecutar(ctx, args.caso, "mapear_campos", async () => {
      const mapeo = calcularMapeo(ctx, args.caso, args.campos)
      // Solo se persiste el mapeo completo de la plantilla (el que usa generar_formulario).
      if (!args.campos || args.campos.length === 0) guardarMapeo(ctx, mapeo)
      const r = resumenMapeo(mapeo)
      return {
        data: { ...r, sha256: mapeo.sha256, ruta_mapeo: rel(ctx, join(outDir(ctx, args.caso), "mapeo.json")) },
        resumen: `llenos ${r.llenos.length} · faltantes ${r.faltantes.length} · por confirmar ${r.requiere_confirmacion.length}`,
      }
    })
  },
})

export const generar_formulario = defineTool({
  description: "Genera el formulario lleno en el formato pedido por el cliente (xlsx o pdf) o, si es portal web, los valores listos para copiar.",
  args: {
    caso: z.string().describe("Nombre de la carpeta del caso"),
    mapeo: z
      .array(z.object({ etiqueta: z.string().describe("Etiqueta del campo"), valor: z.string().nullable().optional().describe("Valor propuesto") }))
      .optional()
      .describe("Opcional y solo informativo: el servidor siempre usa su propio mapeo del maestro y reporta diferencias"),
  },
  async execute(args, ctx) {
    return ejecutar(ctx, args.caso, "generar_formulario", async () => {
      const r = await generarFormularioInterno(ctx, args.caso, args.mapeo)
      return { data: r, resumen: `${r.formato} → ${r.ruta}${r.soportado ? "" : " (formato no soportado)"}` }
    })
  },
})

export const armar_paquete = defineTool({
  description: "Arma el paquete para firma (formulario, soportes vigentes, checklist y borrador de correo) y dice si está listo para firma.",
  args: {
    caso: z.string().describe("Nombre de la carpeta del caso"),
    hoy: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/)
      .optional()
      .describe("Fecha de referencia YYYY-MM-DD para evaluar vigencias; por defecto FECHA_REFERENCIA o la fecha actual"),
  },
  async execute(args, ctx) {
    return ejecutar(ctx, args.caso, "armar_paquete", async () => {
      const hoy = fechaReferencia(args.hoy)
      const { solicitud, soportes } = leerCaso(ctx, args.caso)
      const formulario = await generarFormularioInterno(ctx, args.caso)
      const mapeo = obtenerMapeoServidor(ctx, args.caso)
      const dir = outDir(ctx, args.caso)
      const paquete = join(dir, "paquete")
      rmSync(paquete, { recursive: true, force: true })
      mkdirSync(paquete, { recursive: true })
      const formOrigen = join(ctx.directory, formulario.ruta)
      const formNombre = formOrigen.split("/").pop() ?? "formulario"
      copyFileSync(formOrigen, join(paquete, formNombre))

      const indice = readJson<Soporte[]>(join(ctx.directory, ...FIXTURES, "repositorio", "soportes", "index.json"))
      const presentes: { tipo: string; archivo: string; vigencia_hasta: string | null }[] = []
      const vencidos: { tipo: string; archivo: string; vigencia_hasta: string | null }[] = []
      const ausentes: string[] = []
      for (const tipo of soportes) {
        const s = indice.find((x) => x.tipo === tipo)
        const archivo = s ? join(ctx.directory, ...FIXTURES, "repositorio", "soportes", s.archivo) : null
        if (!s || !archivo || !existsSync(archivo)) {
          ausentes.push(tipo)
          continue
        }
        const item = { tipo, archivo: s.archivo, vigencia_hasta: s.vigencia_hasta }
        if (s.vigencia_hasta !== null && s.vigencia_hasta < hoy) vencidos.push(item)
        else presentes.push(item)
        copyFileSync(archivo, join(paquete, s.archivo)) // se copia también el vencido para que se vea qué reemplazar
      }
      const faltantes = mapeo.entradas.filter((e) => e.estado === "faltante").map((e) => e.etiqueta)
      const porConfirmar = mapeo.entradas.filter((e) => e.estado === "requiere_confirmacion").map((e) => ({ etiqueta: e.etiqueta, nota: e.nota }))
      const listo = vencidos.length === 0 && ausentes.length === 0
      const bloqueos = [
        ...vencidos.map((v) => `Soporte vencido: ${v.tipo} (vigencia hasta ${v.vigencia_hasta})`),
        ...ausentes.map((a) => `Soporte exigido ausente en el repositorio: ${a}`),
      ]

      const checklist = [
        `# Checklist · ${solicitud.cliente} (${args.caso})`,
        "",
        `Fecha de referencia: ${hoy} · Formato: ${formulario.formato} · **Estado: ${listo ? "LISTO PARA FIRMA" : "NO LISTO PARA FIRMA"}**`,
        "",
        "## Soportes",
        "| Soporte | Archivo | Vigencia hasta | Estado |",
        "|---|---|---|---|",
        ...presentes.map((p) => `| ${p.tipo} | ${p.archivo} | ${p.vigencia_hasta ?? "sin vencimiento"} | presente |`),
        ...vencidos.map((v) => `| ${v.tipo} | ${v.archivo} | ${v.vigencia_hasta} | **vencido** |`),
        ...ausentes.map((a) => `| ${a} | — | — | **ausente** |`),
        "",
        "## Campos del formulario",
        `- Faltantes (no bloquean, completar a mano): ${faltantes.length ? faltantes.join("; ") : "ninguno"}`,
        `- Por confirmar: ${porConfirmar.length ? porConfirmar.map((p) => `${p.etiqueta} (${p.nota})`).join("; ") : "ninguno"}`,
        "",
        "## Acciones humanas",
        "- [ ] Revisar campos por confirmar y faltantes",
        ...bloqueos.map((b) => `- [ ] Resolver: ${b}`),
        "- [ ] Firma del representante legal",
        "- [ ] Aprobar el envío al cliente",
        "",
      ].join("\n")
      writeFileSync(join(paquete, "checklist.md"), checklist, "utf8")

      // RN2: el borrador de correo nunca incluye datos bancarios.
      const adjuntos = [formNombre, ...presentes.map((p) => p.archivo)]
      const borrador = [
        `Para: ${solicitud.de}`,
        `Asunto: RE: ${solicitud.asunto}`,
        "",
        "Buen día,",
        "",
        `En respuesta a su solicitud, adjuntamos el formulario de registro de Periferia IT Group S.A.S. firmado por el representante legal y los soportes solicitados:`,
        "",
        ...adjuntos.map((a) => `- ${a}`),
        "",
        "Quedamos atentos a cualquier información adicional.",
        "",
        "Cordialmente,",
        "Área Administrativa · Periferia IT Group S.A.S.",
        "",
        "<!-- BORRADOR: no enviar hasta tener la firma y la aprobación explícita de la analista. -->",
        "",
      ].join("\n")
      writeFileSync(join(paquete, "borrador-correo.md"), borrador, "utf8")
      writeFileSync(join(dir, "estado.json"), JSON.stringify({ listo_para_firma: listo, bloqueos, hoy }, null, 2), "utf8")

      return {
        data: {
          ruta: rel(ctx, paquete),
          listo_para_firma: listo,
          fecha_referencia: hoy,
          bloqueos,
          checklist: { presentes, vencidos, ausentes, campos_faltantes: faltantes, campos_por_confirmar: porConfirmar },
          formulario: formulario.ruta,
          formato_soportado: formulario.soportado,
        },
        resumen: `listo_para_firma=${listo} · vencidos ${vencidos.length} · ausentes ${ausentes.length}`,
      }
    })
  },
})

export const simular_envio = defineTool({
  description: "Simula el envío del paquete al cliente escribiendo ENVIO-SIMULADO.md; solo procede con confirmación explícita del usuario.",
  args: {
    caso: z.string().describe("Nombre de la carpeta del caso"),
    confirmado: z.boolean().optional().describe("true solo si el usuario confirmó explícitamente el envío en su último mensaje"),
  },
  async execute(args, ctx) {
    if (args.confirmado !== true) {
      logCaso(ctx, args.caso, "simular_envio", false, "requiere confirmación explícita")
      return fail("requiere confirmación explícita: pregunta al usuario si autoriza el envío y espera su respuesta.")
    }
    return ejecutar(ctx, args.caso, "simular_envio", async () => {
      const dir = outDir(ctx, args.caso)
      const rutaEstado = join(dir, "estado.json")
      if (!existsSync(rutaEstado)) throw new Error("Primero arma el paquete con armar_paquete.")
      const estado = readJson<{ listo_para_firma: boolean; bloqueos: string[]; hoy: string }>(rutaEstado)
      if (!estado.listo_para_firma) throw new Error(`El paquete no está listo para firma: ${estado.bloqueos.join("; ")}`)
      const { solicitud } = leerCaso(ctx, args.caso)
      const ruta = join(dir, "ENVIO-SIMULADO.md")
      writeFileSync(
        ruta,
        [
          `# Envío simulado · ${args.caso}`,
          "",
          `- Destinatario: ${solicitud.de}`,
          `- Asunto: RE: ${solicitud.asunto}`,
          `- Paquete: out/${args.caso}/paquete/`,
          `- Confirmado por el usuario en el chat (sesión ${ctx.sessionId}).`,
          "- Nota: simulación. No se envió ningún correo real.",
          "",
        ].join("\n"),
        "utf8",
      )
      return { data: { ruta: rel(ctx, ruta) }, resumen: "envío simulado escrito" }
    })
  },
})

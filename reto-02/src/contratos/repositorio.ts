// Acceso a archivos: buzón (solo lectura), maestro simulado de SharePoint (out/), procesados, historial.
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"

export const COLUMNAS = [
  "id_contrato", "cliente", "nit_cliente", "pais", "objeto", "valor", "moneda", "fecha_inicio", "fecha_fin",
  "requiere_poliza", "tipo_poliza", "estado_poliza", "comercial", "ruta_sharepoint", "fecha_registro", "fuente",
] as const
export type Columna = (typeof COLUMNAS)[number]
export type Fila = Record<Columna, string>

export type Correo = { id: string; de: string; para: string; asunto: string; fecha: string; cuerpo: string; adjuntos: string[] }
export type Comercial = { email: string; nombre: string; region: string }

export const rutas = (dir: string) => ({
  fixtures: join(dir, "fixtures", "reto-02"),
  buzon: join(dir, "fixtures", "reto-02", "buzon"),
  maestroFixture: join(dir, "fixtures", "reto-02", "maestro-contratos.csv"),
  comerciales: join(dir, "fixtures", "reto-02", "comerciales.json"),
  sharepoint: join(dir, "out", "sharepoint"),
  maestro: join(dir, "out", "sharepoint", "maestro-contratos.csv"),
  historial: join(dir, "out", "sharepoint", "historial.jsonl"),
  procesados: join(dir, "out", "procesados.json"),
  alertas: join(dir, "out", "alertas.md"),
  log: join(dir, "out", "log.jsonl"),
})

// ---------- CSV mínimo con soporte de comillas ----------
function parseLinea(linea: string): string[] {
  const out: string[] = []
  let actual = ""
  let comillas = false
  for (let i = 0; i < linea.length; i++) {
    const c = linea[i]
    if (comillas) {
      if (c === '"' && linea[i + 1] === '"') { actual += '"'; i++ }
      else if (c === '"') comillas = false
      else actual += c
    } else if (c === '"') comillas = true
    else if (c === ",") { out.push(actual); actual = "" }
    else actual += c
  }
  out.push(actual)
  return out
}

const escapar = (v: string): string => (/[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v)

export function leerCsv(path: string): Fila[] {
  const lineas = readFileSync(path, "utf8").split(/\r?\n/).filter((l) => l.trim())
  const encabezado = parseLinea(lineas[0] ?? "")
  return lineas.slice(1).map((l) => {
    const valores = parseLinea(l)
    const fila = {} as Fila
    for (const col of COLUMNAS) fila[col] = valores[encabezado.indexOf(col)] ?? ""
    return fila
  })
}

export function escribirCsv(path: string, filas: Fila[]): void {
  mkdirSync(dirname(path), { recursive: true })
  const cuerpo = filas.map((f) => COLUMNAS.map((c) => escapar(f[c])).join(","))
  writeFileSync(path, [COLUMNAS.join(","), ...cuerpo].join("\n") + "\n", "utf8")
}

/** RN6: la primera ejecución copia el fixture a out/sharepoint/. El fixture nunca se escribe. */
export function asegurarMaestro(dir: string): string {
  const r = rutas(dir)
  if (!existsSync(r.maestro)) {
    mkdirSync(r.sharepoint, { recursive: true })
    copyFileSync(r.maestroFixture, r.maestro)
  }
  return r.maestro
}

/** Lectura sin efectos: usa la copia de out/ si existe, si no el fixture. */
export function leerMaestro(dir: string): Fila[] {
  const r = rutas(dir)
  return leerCsv(existsSync(r.maestro) ? r.maestro : r.maestroFixture)
}

// ---------- buzón ----------
const idValido = (id: string): boolean => /^[a-zA-Z0-9_-]+$/.test(id)

export function listarMensajes(dir: string): string[] {
  const b = rutas(dir).buzon
  return existsSync(b) ? readdirSync(b).filter((n) => existsSync(join(b, n, "correo.json"))).sort() : []
}

export function leerCorreo(dir: string, mensajeId: string): Correo {
  if (!idValido(mensajeId)) throw new Error(`Identificador de mensaje inválido: ${mensajeId}`)
  const p = join(rutas(dir).buzon, mensajeId, "correo.json")
  if (!existsSync(p)) throw new Error(`El mensaje ${mensajeId} no existe en el buzón.`)
  return JSON.parse(readFileSync(p, "utf8")) as Correo
}

const ES_CONTRATO = /^(contrato|otros[ií])/i

/** Adjunto de contrato del mensaje (contrato.txt u otrosi.txt). null si no hay. */
export function adjuntoContrato(dir: string, correo: Correo): { nombre: string; ruta: string; texto: string } | null {
  const nombre = correo.adjuntos.find((a) => ES_CONTRATO.test(a))
  if (!nombre) return null
  const ruta = join(rutas(dir).buzon, correo.id, nombre)
  if (!existsSync(ruta)) return null
  return { nombre, ruta, texto: readFileSync(ruta, "utf8") }
}

export function comerciales(dir: string): Comercial[] {
  return JSON.parse(readFileSync(rutas(dir).comerciales, "utf8")) as Comercial[]
}

// ---------- procesados ----------
export type Procesado = { clasificacion: string; id_contrato: string | null; accion: string; ts: string }

export function leerProcesados(dir: string): Record<string, Procesado> {
  const p = rutas(dir).procesados
  return existsSync(p) ? (JSON.parse(readFileSync(p, "utf8")) as Record<string, Procesado>) : {}
}

export function marcarProcesado(dir: string, mensajeId: string, info: Procesado): void {
  const actuales = leerProcesados(dir)
  actuales[mensajeId] = info
  const p = rutas(dir).procesados
  mkdirSync(dirname(p), { recursive: true })
  writeFileSync(p, JSON.stringify(actuales, null, 2), "utf8")
}

export function archivar(dir: string, origen: string, anio: string, clienteSlug: string, nombre: string): string {
  const relativa = join("Contratos", anio, clienteSlug, nombre)
  const destino = join(rutas(dir).sharepoint, relativa)
  mkdirSync(dirname(destino), { recursive: true })
  copyFileSync(origen, destino)
  return relativa
}

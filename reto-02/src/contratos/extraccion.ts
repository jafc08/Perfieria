// Extracción determinista de contratos desde texto (regex + heurísticas).
// El modelo de lenguaje NO participa aquí: cada valor sale del texto o de una derivación explícita.

export type Fuente = "regex" | "derivado" | "ausente"
export type Campo<T> = { valor: T | null; confianza: number; fuente: Fuente; nota?: string }

export const MONEDAS = ["COP", "USD", "PEN", "PAB", "HNL"] as const
export type Moneda = (typeof MONEDAS)[number]
export type Pais = "CO" | "EC" | "PE" | "PA" | "HN"

export type ContratoExtraido = {
  id_contrato: Campo<string>
  es_otrosi: boolean
  cliente: Campo<string>
  nit_cliente: Campo<string>
  pais: Campo<Pais>
  objeto: Campo<string>
  valor: Campo<number>
  valor_indeterminado: boolean
  moneda: Campo<Moneda>
  fecha_inicio: Campo<string>
  fecha_fin: Campo<string>
  requiere_poliza: Campo<boolean>
  tipo_poliza: Campo<string>
  ampliar_poliza: boolean
}

export const CAMPOS_REGISTRABLES = [
  "id_contrato",
  "cliente",
  "nit_cliente",
  "pais",
  "objeto",
  "valor",
  "moneda",
  "fecha_inicio",
  "fecha_fin",
  "requiere_poliza",
  "tipo_poliza",
] as const
export type CampoRegistrable = (typeof CAMPOS_REGISTRABLES)[number]

const MESES: Record<string, number> = {
  enero: 1, febrero: 2, marzo: 3, abril: 4, mayo: 5, junio: 6,
  julio: 7, agosto: 8, septiembre: 9, setiembre: 9, octubre: 10, noviembre: 11, diciembre: 12,
}

const campo = <T>(valor: T | null, confianza: number, fuente: Fuente, nota?: string): Campo<T> =>
  nota ? { valor, confianza, fuente, nota } : { valor, confianza, fuente }
const ausente = <T>(nota?: string): Campo<T> => campo<T>(null, 0, "ausente", nota)

export class ErrorExtraccion extends Error {}

const pad = (n: number): string => String(n).padStart(2, "0")
export const isoDate = (y: number, m: number, d: number): string => `${y}-${pad(m)}-${pad(d)}`

export function esFechaValida(s: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false
  const d = new Date(`${s}T00:00:00Z`)
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s
}

/** Suma meses conservando el día (si no existe, último día del mes). */
export function sumarMeses(iso: string, meses: number): string {
  const [y, m, d] = iso.split("-").map(Number) as [number, number, number]
  const total = m - 1 + meses
  const ny = y + Math.floor(total / 12)
  const nm = (total % 12) + 1
  const ultimo = new Date(Date.UTC(ny, nm, 0)).getUTCDate()
  return isoDate(ny, nm, Math.min(d, ultimo))
}

export function parseNumero(raw: string): number | null {
  const s = raw.trim().replace(/\s/g, "")
  if (/^\d{1,3}(\.\d{3})+(,\d+)?$/.test(s)) return Number(s.replace(/\./g, "").replace(",", "."))
  if (/^\d{1,3}(,\d{3})+(\.\d+)?$/.test(s)) return Number(s.replace(/,/g, ""))
  if (/^\d+([.,]\d+)?$/.test(s)) return Number(s.replace(",", "."))
  return null
}

function parrafos(texto: string): string[] {
  return texto.split(/\n\s*\n/).map((p) => p.replace(/\s+/g, " ").trim()).filter(Boolean)
}

function fechasEnTexto(p: string): string[] {
  const re = /\((\d{1,2})\)\s+de\s+([a-záéíóú]+)\s+de\s+(\d{4})/gi
  const out: string[] = []
  for (const m of p.matchAll(re)) {
    const mes = MESES[(m[2] ?? "").toLowerCase()]
    if (mes) out.push(isoDate(Number(m[3]), mes, Number(m[1])))
  }
  return out
}

export function tipoDocumento(texto: string): "contrato" | "otrosi" | "otro" {
  const primera = (texto.trim().split("\n")[0] ?? "").toUpperCase()
  if (primera.includes("OTROSÍ") || primera.includes("OTROSI")) return "otrosi"
  if (primera.includes("CONTRATO")) return "contrato"
  return "otro"
}

type Parte = { nombre: string; tipoId: string; id: string }

function partes(texto: string): Parte[] {
  const plano = texto.replace(/\s+/g, " ")
  const re = /(?:Entre(?: los suscritos,)?|,\s*y)\s+([A-ZÁÉÍÓÚÑÜ][A-ZÁÉÍÓÚÑÜ0-9 .&-]*?),\s+(?:identificada con\s+)?(NIT|RUC|RTN)\s+([\d.\-]+\d)/g
  return [...plano.matchAll(re)].map((m) => ({ nombre: (m[1] ?? "").trim(), tipoId: m[2] ?? "", id: m[3] ?? "" }))
}

const sinTildes = (s: string): string => s.normalize("NFD").replace(/[̀-ͯ]/g, "")

/** Busca el nombre con mayúsculas/minúsculas correctas en el bloque de firmas. */
function nombreLegible(texto: string, mayus: string): Campo<string> {
  for (const linea of texto.split("\n")) {
    for (const seg of linea.split(/\s{2,}/)) {
      if (seg.trim() && seg.trim().toUpperCase() === mayus) return campo(seg.trim(), 0.95, "regex")
    }
  }
  const titulo = mayus.toLowerCase().replace(/(^|\s)(\p{L})/gu, (_, a: string, b: string) => a + b.toUpperCase())
  return campo(titulo, 0.85, "derivado", "nombre convertido desde mayúsculas")
}

function normalizarId(tipo: string, id: string): string {
  const base = tipo === "NIT" && id.includes("-") ? id.slice(0, id.lastIndexOf("-")) : id
  return base.replace(/[.\-]/g, "")
}

function inferirPais(tipo: string, id: string, texto: string): Campo<Pais> {
  const dom = sinTildes(texto).toLowerCase()
  if (tipo === "NIT") return campo<Pais>("CO", 0.95, "regex")
  if (tipo === "RTN") return campo<Pais>("HN", 0.95, "regex")
  if (/^\d{13}$/.test(id) && id.endsWith("001")) return campo<Pais>("EC", dom.includes("ecuador") ? 0.95 : 0.85, "regex")
  if (/^\d{11}$/.test(id)) return campo<Pais>("PE", dom.includes("peru") ? 0.95 : 0.85, "regex")
  if (dom.includes("panama")) return campo<Pais>("PA", 0.85, "regex")
  return ausente<Pais>("identificador no reconocido")
}

function extraerId(texto: string, tipo: "contrato" | "otrosi"): Campo<string> {
  const plano = texto.replace(/\s+/g, " ")
  const re = tipo === "otrosi"
    ? /AL CONTRATO[^.]*?No\.\s*([A-Z]{2,4}-\d{4}-\d+)/i
    : /No\.\s*([A-Z]{2,4}-\d{4}-\d+)/i
  const m = plano.match(re)
  return m?.[1] ? campo(m[1], 0.95, "regex") : ausente("sin número de contrato (se asignará AUTO-<año>-<seq>)")
}

function extraerObjeto(ps: string[]): Campo<string> {
  const p = ps.find((x) => /OBJETO\./.test(x))
  if (!p) return ausente()
  const limpio = p
    .replace(/^.*?OBJETO\.\s*/, "")
    .replace(/^EL CONTRATISTA\s+(se obliga a\s+|prestar[aá]\s+)?/i, "")
    .trim()
  const texto = limpio.charAt(0).toUpperCase() + limpio.slice(1)
  return texto.length > 200
    ? campo(texto.slice(0, 197) + "...", 0.85, "regex", "objeto truncado a 200 caracteres")
    : campo(texto, 0.9, "regex")
}

type Valor = { valor: Campo<number>; moneda: Campo<Moneda>; indeterminado: boolean }

function extraerValor(ps: string[], pais: Pais | null): Valor {
  const p = ps.find((x) => /\(VALOR\)|VALOR\./.test(x))
  if (!p) return { valor: ausente(), moneda: ausente(), indeterminado: false }
  if (/no tiene un valor determinado|valor indeterminado|por demanda/i.test(p)) {
    const monedaPais: Record<Pais, Moneda> = { CO: "COP", EC: "USD", PE: "PEN", PA: "USD", HN: "HNL" }
    return {
      valor: campo(0, 0.6, "derivado", "contrato por demanda: valor 0 con valor_indeterminado=true"),
      moneda: pais ? campo(monedaPais[pais], 0.6, "derivado", "moneda inferida del país") : ausente(),
      indeterminado: true,
    }
  }
  const m = p.match(/\(([A-Z]{3})\s*\$?\s*([\d.,]+)\)/)
  if (!m) return { valor: ausente("no se encontró cifra en la cláusula de valor"), moneda: ausente(), indeterminado: false }
  const codigo = m[1] ?? ""
  if (!(MONEDAS as readonly string[]).includes(codigo)) throw new ErrorExtraccion(`Moneda desconocida "${codigo}". Monedas válidas: ${MONEDAS.join(", ")}.`)
  const num = parseNumero(m[2] ?? "")
  return {
    valor: num === null ? ausente(`cifra ilegible: ${m[2]}`) : campo(num, 0.95, "regex"),
    moneda: campo(codigo as Moneda, 0.95, "regex"),
    indeterminado: false,
  }
}

function fechaFirma(ps: string[], fechaCorreo: string): Campo<string> {
  const p = ps.find((x) => /se firma/i.test(x)) ?? ""
  const conDia = p.match(/\((\d{1,2})\)\s+d[ií]as del mes de\s+([a-záéíóú]+)\s+de\s+(\d{4})/i)
  const mesConDia = conDia ? MESES[(conDia[2] ?? "").toLowerCase()] : undefined
  if (conDia && mesConDia) return campo(isoDate(Number(conDia[3]), mesConDia, Number(conDia[1])), 0.95, "regex")
  const soloMes = p.match(/en el mes de\s+([a-záéíóú]+)\s+de\s+(\d{4})/i)
  const mes = soloMes ? MESES[(soloMes[1] ?? "").toLowerCase()] : undefined
  if (soloMes && mes) {
    const y = Number(soloMes[2])
    const correoMismoMes = fechaCorreo.startsWith(`${y}-${pad(mes)}`)
    const d = correoMismoMes ? fechaCorreo : isoDate(y, mes, new Date(Date.UTC(y, mes, 0)).getUTCDate())
    return campo(d, 0.5, "derivado", "firma sin día: se asume la fecha del correo (o fin de mes)")
  }
  return ausente()
}

type Fechas = { inicio: Campo<string>; fin: Campo<string> }

function extraerFechas(ps: string[], tipo: "contrato" | "otrosi", fechaCorreo: string): Fechas {
  const p = ps.find((x) => /\(PLAZO\)|PLAZO\./.test(x))
  if (!p) return { inicio: ausente(), fin: ausente() }
  const fechas = fechasEnTexto(p)
  if (tipo === "otrosi") {
    return { inicio: ausente("el otrosí no modifica la fecha de inicio"), fin: fechas[0] ? campo(fechas[0], 0.95, "regex") : ausente() }
  }
  if (fechas.length >= 2) return { inicio: campo(fechas[0] ?? null, 0.95, "regex"), fin: campo(fechas[1] ?? null, 0.95, "regex") }
  const meses = p.match(/\((\d{1,3})\)\s*meses/i)
  const n = meses ? Number(meses[1]) : null
  const prorroga = /prorrogab/i.test(p) ? "; prórroga automática por periodos iguales" : ""
  if (fechas.length === 1 && n) {
    const ini = fechas[0] ?? ""
    return { inicio: campo(ini, 0.95, "regex"), fin: campo(sumarMeses(ini, n), 0.85, "derivado", `inicio + ${n} meses${prorroga}`) }
  }
  if (n && /firma/i.test(p)) {
    const firma = fechaFirma(ps, fechaCorreo)
    if (firma.valor === null) return { inicio: ausente("plazo contado desde la firma, sin fecha de firma"), fin: ausente() }
    const conf = Math.min(firma.confianza, 0.85)
    return {
      inicio: campo(firma.valor, firma.confianza, "derivado", `fecha de firma${firma.nota ? ` (${firma.nota})` : ""}`),
      fin: campo(sumarMeses(firma.valor, n), conf, "derivado", `firma + ${n} meses${prorroga}`),
    }
  }
  return { inicio: fechas[0] ? campo(fechas[0], 0.7, "regex") : ausente(), fin: ausente() }
}

const TIPOS_POLIZA: Array<[RegExp, string]> = [
  [/cumplimiento/i, "cumplimiento"],
  [/responsabilidad civil/i, "responsabilidad_civil"],
  [/calidad/i, "calidad"],
  [/salarios/i, "salarios_prestaciones"],
]

type Poliza = { requiere: Campo<boolean>; tipo: Campo<string>; ampliar: boolean }

function extraerPoliza(ps: string[], tipo: "contrato" | "otrosi"): Poliza {
  const p = ps.find((x) => /GARANT[IÍ]AS?\.|garant[ií]as/i.test(x))
  if (!p) {
    return tipo === "otrosi"
      ? { requiere: ausente("el otrosí no menciona garantías"), tipo: ausente(), ampliar: false }
      : { requiere: campo(false, 0.9, "regex", "sin cláusula de garantías"), tipo: campo("", 0.9, "regex"), ampliar: false }
  }
  const tipos = TIPOS_POLIZA.filter(([re]) => re.test(p)).map(([, t]) => t).join(";")
  const ampliar = /deber[aá]n ampliarse|ampliar(se)? en vigencia/i.test(p)
  if (/para cada orden|cuyo valor supere|en caso de que/i.test(p)) {
    return {
      requiere: campo(true, 0.5, "regex", "póliza condicionada (solo para órdenes que superen un umbral)"),
      tipo: campo(tipos, 0.7, "regex"),
      ampliar,
    }
  }
  return { requiere: campo(true, 0.95, "regex"), tipo: campo(tipos, 0.9, "regex"), ampliar }
}

/** Punto de entrada: texto del adjunto → contrato con confianza por campo. Lanza ErrorExtraccion (la herramienta la captura). */
export function extraerContrato(texto: string, fechaCorreo: string): ContratoExtraido {
  if (!texto.trim()) throw new ErrorExtraccion("El adjunto está vacío.")
  const tipo = tipoDocumento(texto)
  if (tipo === "otro") throw new ErrorExtraccion("El adjunto no es un contrato ni un otrosí.")
  const lista = partes(texto)
  const contraparte = lista.find((x) => !/PERIFERIA/i.test(x.nombre))
  const ps = parrafos(texto)
  const objeto = extraerObjeto(ps)
  if (!contraparte || (tipo === "contrato" && objeto.valor === null)) {
    throw new ErrorExtraccion("El texto no contiene partes y objeto identificables.")
  }
  const nit = normalizarId(contraparte.tipoId, contraparte.id)
  const pais = inferirPais(contraparte.tipoId, nit, texto)
  const valor = extraerValor(ps, pais.valor)
  const fechas = extraerFechas(ps, tipo, fechaCorreo)
  for (const f of [fechas.inicio, fechas.fin]) {
    if (f.valor !== null && !esFechaValida(f.valor)) throw new ErrorExtraccion(`Fecha inválida en el contrato: ${f.valor}`)
  }
  const poliza = extraerPoliza(ps, tipo)
  return {
    id_contrato: extraerId(texto, tipo),
    es_otrosi: tipo === "otrosi",
    cliente: nombreLegible(texto, contraparte.nombre),
    nit_cliente: campo(nit, 0.95, "regex"),
    pais,
    objeto,
    valor: valor.valor,
    valor_indeterminado: valor.indeterminado,
    moneda: valor.moneda,
    fecha_inicio: fechas.inicio,
    fecha_fin: fechas.fin,
    requiere_poliza: poliza.requiere,
    tipo_poliza: poliza.tipo,
    ampliar_poliza: poliza.ampliar,
  }
}

export function slug(s: string): string {
  return sinTildes(s)
    .toLowerCase()
    .replace(/\b(s\.?\s?a\.?\s?s\.?|s\.?\s?a\.?\s?c\.?|s\.?\s?a\.?|ltda\.?|s\.? de r\.?\s?l\.?)\s*$/i, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
}

/** Jaccard sobre tokens significativos (sin stopwords). */
const STOP = new Set("el la los las de del y a en para con por un una al se su sus que o e lo como bajo desde".split(" "))
export function similitud(a: string, b: string): number {
  const tok = (s: string): Set<string> =>
    new Set(sinTildes(s).toLowerCase().split(/[^a-z0-9]+/).filter((t) => t.length > 2 && !STOP.has(t)))
  const A = tok(a)
  const B = tok(b)
  if (!A.size || !B.size) return 0
  let inter = 0
  for (const t of A) if (B.has(t)) inter++
  return inter / (A.size + B.size - inter)
}

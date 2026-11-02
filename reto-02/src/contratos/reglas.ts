// Reglas de negocio RN1–RN5: clasificación, revisión humana y construcción de filas.
import {
  CAMPOS_REGISTRABLES, MONEDAS, esFechaValida, parseNumero, similitud, slug,
  type CampoRegistrable, type ContratoExtraido,
} from "./extraccion"
import type { Comercial, Fila } from "./repositorio"

export const UMBRAL_CONFIANZA = 0.8
export const UMBRAL_SIMILITUD_OBJETO = 0.9

export type Valor = string | number | boolean | null
export type Valores = Record<CampoRegistrable, Valor>
export type Diferencia = { campo: string; antes: string; despues: string }
export type Clasificacion = "nuevo" | "actualizacion" | "duplicado" | "rechazado"

export type Validacion = {
  clasificacion: Clasificacion
  id_contrato_existente?: string
  requiere_revision: string[]
  diferencias: Diferencia[]
  comercial: { email: string; nombre: string | null; registrado: boolean }
  advertencias: string[]
  motivo?: string
}

export function valoresDe(c: ContratoExtraido): Valores {
  const v = {} as Valores
  for (const k of CAMPOS_REGISTRABLES) v[k] = c[k].valor
  return v
}

const aTexto = (v: Valor): string => (v === null ? "" : String(v))

/** Normaliza un valor propuesto por el modelo/usuario al tipo del campo. Devuelve error legible si no es válido. */
function normalizar(campo: CampoRegistrable, bruto: unknown): { valor: Valor } | { error: string } {
  const crudo = bruto !== null && typeof bruto === "object" && "valor" in bruto ? (bruto as { valor: unknown }).valor : bruto
  if (crudo === null || crudo === undefined) return { valor: null }
  if (campo === "valor") {
    const n = typeof crudo === "number" ? crudo : parseNumero(String(crudo))
    return n === null || Number.isNaN(n) ? { error: `valor no numérico: ${String(crudo)}` } : { valor: n }
  }
  if (campo === "requiere_poliza") {
    if (typeof crudo === "boolean") return { valor: crudo }
    const s = String(crudo).toLowerCase()
    return s === "true" || s === "false" ? { valor: s === "true" } : { error: `requiere_poliza inválido: ${s}` }
  }
  const s = String(crudo).trim()
  if ((campo === "fecha_inicio" || campo === "fecha_fin") && !esFechaValida(s)) return { error: `fecha inválida en ${campo}: ${s} (formato YYYY-MM-DD)` }
  if (campo === "moneda" && !(MONEDAS as readonly string[]).includes(s)) return { error: `moneda desconocida: ${s}` }
  return { valor: s }
}

/** Aplica al resultado de la extracción los valores que propone el modelo. Devuelve los campos que difieren. */
export function aplicarPropuesta(
  base: Valores,
  propuesta: Record<string, unknown> | undefined,
): { valores: Valores; correcciones: Diferencia[] } | { error: string } {
  const valores: Valores = { ...base }
  const correcciones: Diferencia[] = []
  if (!propuesta) return { valores, correcciones }
  for (const campo of CAMPOS_REGISTRABLES) {
    if (!(campo in propuesta)) continue
    const n = normalizar(campo, propuesta[campo])
    if ("error" in n) return { error: n.error }
    if (n.valor === null || aTexto(n.valor) === aTexto(base[campo])) continue
    correcciones.push({ campo, antes: aTexto(base[campo]), despues: aTexto(n.valor) })
    valores[campo] = n.valor
  }
  return { valores, correcciones }
}

function resolverComercial(email: string, lista: Comercial[]): Validacion["comercial"] {
  const c = lista.find((x) => x.email.toLowerCase() === email.toLowerCase())
  return { email, nombre: c?.nombre ?? null, registrado: Boolean(c) }
}

function camposEnRevision(c: ContratoExtraido, valores: Valores, esActualizacion: boolean): string[] {
  const out: string[] = []
  for (const k of CAMPOS_REGISTRABLES) {
    const f = c[k]
    if (f.confianza >= UMBRAL_CONFIANZA) continue
    if (esActualizacion && f.valor === null) continue // el otrosí no trae el campo: se conserva el del maestro
    if (k === "id_contrato" && f.valor === null) continue // RN: se asigna AUTO-<año>-<seq>
    if (k === "tipo_poliza" && valores.requiere_poliza === false) continue
    out.push(`${k}${f.nota ? ` (${f.nota})` : ""}`)
  }
  return out
}

function diferenciasContra(fila: Fila, valores: Valores, c: ContratoExtraido): Diferencia[] {
  const out: Diferencia[] = []
  for (const k of CAMPOS_REGISTRABLES) {
    if (k === "id_contrato" || valores[k] === null) continue
    if (k === "cliente" || k === "objeto") continue // texto libre: se reporta aparte, no fuerza actualización
    const nuevo = aTexto(valores[k])
    if (nuevo !== fila[k]) out.push({ campo: k, antes: fila[k], despues: nuevo })
  }
  if (c.ampliar_poliza && fila.requiere_poliza === "true" && fila.estado_poliza === "vigente") {
    out.push({ campo: "estado_poliza", antes: "vigente", despues: "pendiente" })
  }
  return out
}

export function clasificar(
  c: ContratoExtraido,
  valores: Valores,
  maestro: Fila[],
  correoDe: string,
  lista: Comercial[],
  correcciones: Diferencia[],
): Validacion {
  const comercial = resolverComercial(correoDe, lista)
  const advertencias: string[] = []
  if (!comercial.registrado) advertencias.push(`Remitente ${correoDe} no está en comerciales.json (se reporta, no bloquea).`)
  const id = typeof valores.id_contrato === "string" ? valores.id_contrato : null
  const nit = aTexto(valores.nit_cliente)
  let fila = id ? maestro.find((r) => r.id_contrato === id) : undefined
  if (!fila && nit && typeof valores.objeto === "string") {
    const objeto = valores.objeto
    fila = maestro.find((r) => r.nit_cliente === nit && similitud(r.objeto, objeto) >= UMBRAL_SIMILITUD_OBJETO)
  }
  for (const r of maestro) {
    if (r.nit_cliente === nit && r !== fila) {
      const s = similitud(r.objeto, aTexto(valores.objeto))
      advertencias.push(`Mismo cliente que ${r.id_contrato} (similitud de objeto ${s.toFixed(2)} < ${UMBRAL_SIMILITUD_OBJETO}): se trata como contrato distinto.`)
    }
  }
  const revisionCorrecciones = correcciones.map((d) => `${d.campo} (difiere de la extracción: ${d.antes || "vacío"} → ${d.despues})`)

  if (!fila) {
    return {
      clasificacion: "nuevo",
      requiere_revision: [...camposEnRevision(c, valores, false), ...revisionCorrecciones],
      diferencias: [],
      comercial,
      advertencias,
    }
  }
  const conflictos: string[] = []
  if (nit && fila.nit_cliente !== nit) conflictos.push(`nit_cliente (documento ${nit} vs maestro ${fila.nit_cliente})`)
  const mismaBase = aTexto(valores.valor) === fila.valor && aTexto(valores.fecha_inicio) === fila.fecha_inicio && aTexto(valores.fecha_fin) === fila.fecha_fin
  if (!c.es_otrosi && mismaBase && !conflictos.length) {
    return {
      clasificacion: "duplicado",
      id_contrato_existente: fila.id_contrato,
      requiere_revision: [],
      diferencias: [],
      comercial,
      advertencias,
      motivo: `Mismo id_contrato, valor y fechas que ${fila.id_contrato} (RN1). No se escribe nada.`,
    }
  }
  return {
    clasificacion: "actualizacion",
    id_contrato_existente: fila.id_contrato,
    requiere_revision: [...camposEnRevision(c, valores, true), ...conflictos, ...revisionCorrecciones],
    diferencias: diferenciasContra(fila, valores, c),
    comercial,
    advertencias,
  }
}

export function idAutomatico(maestro: Fila[], anio: string): string {
  const n = maestro.filter((r) => r.id_contrato.startsWith(`AUTO-${anio}-`)).length + 1
  return `AUTO-${anio}-${String(n).padStart(3, "0")}`
}

export function filaNueva(valores: Valores, comercial: Validacion["comercial"], ruta: string, fechaRegistro: string, id: string): Fila {
  const requiere = valores.requiere_poliza === true
  return {
    id_contrato: id,
    cliente: aTexto(valores.cliente),
    nit_cliente: aTexto(valores.nit_cliente),
    pais: aTexto(valores.pais),
    objeto: aTexto(valores.objeto).slice(0, 200),
    valor: aTexto(valores.valor ?? 0),
    moneda: aTexto(valores.moneda),
    fecha_inicio: aTexto(valores.fecha_inicio),
    fecha_fin: aTexto(valores.fecha_fin),
    requiere_poliza: String(requiere),
    tipo_poliza: requiere ? aTexto(valores.tipo_poliza) : "",
    estado_poliza: requiere ? "pendiente" : "no_aplica",
    comercial: comercial.nombre ?? `${comercial.email} (no registrado)`,
    ruta_sharepoint: ruta,
    fecha_registro: fechaRegistro,
    fuente: "buzon",
  }
}

export const slugCliente = (cliente: Valor): string => slug(aTexto(cliente)) || "sin-cliente"

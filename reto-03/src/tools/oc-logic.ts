// Lógica determinista del reto 03: lectura del paquete, controles RC1–RC10, payload y evidencia.
// Sin modelo de lenguaje: todo valor sale de los fixtures o de los maestros.
import { createHash } from "node:crypto"
import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import {
  OrdenCompraSchema,
  SolicitudSchema,
  type Derivado,
  type Hallazgo,
  type OrdenCompra,
  type Paquete,
  type Validacion,
} from "./schema"

// ---------- maestros ----------
export type Proveedor = {
  codigo_sap: string
  nit: string
  nombre: string
  condiciones_pago_default: string
  indicador_iva_default: string
  activo: boolean
}
export type Aprobador = { email: string; nombre: string; tope: number }
export type CentroCosto = { centro_costo: string; nombre: string; subareas: string[]; aprobadores: Aprobador[] }
export type IndicadorIva = { codigo: string; descripcion: string; tasa: number }
export type CondicionPago = { codigo: string; descripcion: string; dias: number }
export type Maestros = {
  proveedores: Proveedor[]
  centros: CentroCosto[]
  iva: IndicadorIva[]
  pagos: CondicionPago[]
}

export type Resultado<T> = { ok: true; data: T } | { ok: false; error: string }

const fixturesDir = (dir: string): string => join(dir, "fixtures", "reto-03")

function leerJson(ruta: string): unknown {
  return JSON.parse(readFileSync(ruta, "utf8")) as unknown
}

export function cargarMaestros(dir: string): Maestros {
  const m = join(fixturesDir(dir), "maestros")
  return {
    proveedores: leerJson(join(m, "proveedores.json")) as Proveedor[],
    centros: leerJson(join(m, "centros-costo.json")) as CentroCosto[],
    iva: leerJson(join(m, "indicadores-iva.json")) as IndicadorIva[],
    pagos: leerJson(join(m, "condiciones-pago.json")) as CondicionPago[],
  }
}

// ---------- normalización ----------
export const sinTildes = (s: string): string => s.normalize("NFD").replace(/\p{M}/gu, "")
export const normEmail = (s: string): string => sinTildes(s.normalize("NFC").trim().toLowerCase())
export function normNit(s: string): string {
  return s.replace(/\s/g, "").replace(/-\d$/, "").replace(/\D/g, "")
}
export function normNombre(s: string): string {
  return sinTildes(s.toLowerCase())
    .replace(/[^a-z0-9 ]/g, " ")
    .split(/\s+/)
    .filter((t) => t && !["s", "a", "sas", "sa", "ltda", "de", "r", "l", "rl"].includes(t))
    .join(" ")
}
/** "COP 11.400.000" → 11400000 ; "USD 1,250.50" → 1250.5 */
export function parseMonto(raw: string): number | null {
  const s = raw.replace(/[A-Z]{3}|\$|\s/g, "")
  let n: string
  if (/^\d{1,3}(\.\d{3})+(,\d+)?$/.test(s)) n = s.replace(/\./g, "").replace(",", ".")
  else if (/^\d{1,3}(,\d{3})+(\.\d+)?$/.test(s)) n = s.replace(/,/g, "")
  else n = s.replace(",", ".")
  const v = Number(n)
  return Number.isFinite(v) ? v : null
}
const round2 = (n: number): number => Math.round(n * 100) / 100
export const fmt = (n: number): string => n.toLocaleString("es-CO", { maximumFractionDigits: 2 })
const sumarDias = (fecha: string, dias: number): string => {
  const d = new Date(`${fecha}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() + dias)
  return d.toISOString().slice(0, 10)
}

/** Detecta aprobación explícita y descarta negaciones ("no aprobado", "no se aprueba", "rechazado"). */
export function esAprobado(texto: string): boolean {
  const t = sinTildes(texto.toLowerCase())
  if (/\bno\s+(se\s+)?(esta\s+)?aprob/.test(t) || /\brechaz/.test(t) || /\bdesaprob/.test(t)) return false
  return /\baprobad[oa]\b/.test(t)
}

/** Monto limitado en el texto de la aprobación: "por 25 millones", "por $25.000.000". */
export function montoAprobado(texto: string): number | null {
  const t = sinTildes(texto.toLowerCase())
  const m = t.match(/por\s+(?:cop\s*)?\$?\s*([\d.,]+)\s*(millones|millon|mill|m\b)?/)
  if (!m) return null
  const base = parseMonto(m[1])
  if (base === null) return null
  return m[2] ? base * 1_000_000 : base
}

// ---------- lectura del paquete (HU-1) ----------
const CASO_RE = /^[a-z0-9-]+$/

function leerTexto(ruta: string): string | null {
  return existsSync(ruta) ? readFileSync(ruta, "utf8") : null
}

function parsearCotizacion(texto: string): NonNullable<Paquete["cotizacion"]> | { error: string } {
  const numero = texto.match(/^\s*COTIZACI[ÓO]N\s+(?:No\.\s*)?(\S+)/im)?.[1] ?? null
  const fecha = texto.match(/^Fecha:\s*(\d{4}-\d{2}-\d{2})/im)?.[1] ?? null
  const proveedor = texto.match(/^Proveedor:\s*(.+)$/im)?.[1].trim() ?? ""
  const nitRaw = texto.match(/^NIT:\s*([\d.\-\s]+)$/im)?.[1] ?? null
  const totalM = texto.match(/^TOTAL[^:\n]*:\s*([A-Z]{3})\s*([\d.,]+)/im)
  if (!totalM) return { error: "la cotización no tiene un TOTAL legible" }
  const total = parseMonto(totalM[2])
  if (total === null) return { error: `TOTAL no numérico en la cotización: "${totalM[2]}"` }
  const dias = texto.match(/Validez de la oferta:\s*(\d+)\s*d[ií]as/i)?.[1]
  return {
    proveedor,
    nit: nitRaw ? normNit(nitRaw) : null,
    total,
    moneda: totalM[1],
    validez_hasta: fecha && dias ? sumarDias(fecha, Number(dias)) : null,
    texto,
    numero,
    fecha,
  }
}

function parsearFactura(texto: string): NonNullable<Paquete["factura"]> | { error: string } {
  const numero = texto.match(/No\.\s*(\S+)/)?.[1]
  const fecha = texto.match(/Fecha de emisi[óo]n:\s*(\d{4}-\d{2}-\d{2})/i)?.[1]
  const totalRaw = texto.match(/^TOTAL[^:\n]*:\s*[A-Z]{3}\s*([\d.,]+)/im)?.[1]
  const total = totalRaw ? parseMonto(totalRaw) : null
  if (!numero || !fecha || total === null) return { error: "la factura no tiene número, fecha de emisión o total legibles" }
  return { numero, fecha, total }
}

type CorreoRaw = { id?: string; de?: string; asunto?: string; fecha?: string; cuerpo?: string }
type AprobacionRaw = { de?: string; para?: string; fecha?: string; asunto?: string; cuerpo?: string }

export function cargarPaquete(dir: string, caso: string): Resultado<Paquete> {
  if (!CASO_RE.test(caso)) return { ok: false, error: `Nombre de caso inválido: "${caso}". Use el nombre de la carpeta, p. ej. "sol-001".` }
  const carpeta = join(fixturesDir(dir), "solicitudes", caso)
  if (!existsSync(carpeta)) return { ok: false, error: `El caso "${caso}" no existe en fixtures/reto-03/solicitudes/.` }
  const faltantes: string[] = []

  // correo
  let correoRaw: CorreoRaw
  try {
    correoRaw = leerJson(join(carpeta, "correo.json")) as CorreoRaw
  } catch {
    return { ok: false, error: "correo.json ausente o con JSON malformado: pedir al solicitante que reenvíe el correo de solicitud." }
  }

  // solicitud
  let solicitudRaw: unknown
  try {
    solicitudRaw = leerJson(join(carpeta, "solicitud.json"))
  } catch {
    return { ok: false, error: "Falta la solicitud (Excel) o está malformada: pedir al solicitante el Excel de solicitud completo." }
  }
  const sol = SolicitudSchema.safeParse(solicitudRaw)
  if (!sol.success) {
    const detalle = sol.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")
    return { ok: false, error: `Solicitud inválida (${detalle}). Pedir al solicitante corregir esos campos en el Excel.` }
  }

  // cotización
  let cotizacion: Paquete["cotizacion"] = null
  const cotTxt = leerTexto(join(carpeta, "cotizacion.txt"))
  if (cotTxt === null) faltantes.push("cotizacion")
  else {
    const c = parsearCotizacion(cotTxt)
    if ("error" in c) return { ok: false, error: `Cotización ilegible: ${c.error}. Pedir al proveedor una cotización con total.` }
    cotizacion = c
  }

  // aprobación
  let aprobacion: Paquete["aprobacion"] = null
  const aprPath = join(carpeta, "aprobacion.json")
  if (!existsSync(aprPath)) faltantes.push("aprobacion")
  else {
    try {
      const a = leerJson(aprPath) as AprobacionRaw
      const texto = a.cuerpo ?? ""
      aprobacion = {
        de: (a.de ?? "").trim(),
        para: (a.para ?? "").trim(),
        asunto: a.asunto ?? "",
        fecha: a.fecha ?? "",
        aprobado: esAprobado(texto),
        texto,
      }
    } catch {
      return { ok: false, error: "aprobacion.json malformado: pedir al solicitante reenviar el correo de aprobación del líder." }
    }
  }

  // factura (opcional)
  let factura: Paquete["factura"] = null
  const facTxt = leerTexto(join(carpeta, "factura.txt"))
  if (facTxt !== null) {
    const f = parsearFactura(facTxt)
    if ("error" in f) return { ok: false, error: `Factura ilegible: ${f.error}.` }
    factura = f
  }

  return {
    ok: true,
    data: {
      correo: {
        id: correoRaw.id ?? caso,
        de: correoRaw.de ?? "",
        asunto: correoRaw.asunto ?? "",
        fecha: correoRaw.fecha ?? "",
        cuerpo: correoRaw.cuerpo ?? "",
      },
      solicitud: sol.data,
      cotizacion,
      aprobacion,
      factura,
      faltantes,
    },
  }
}

// ---------- controles RC1–RC10 (HU-2) ----------
export function buscarProveedor(m: Maestros, p: Paquete): { proveedor: Proveedor | null; via: "nit" | "nombre" | null } {
  const s = p.solicitud
  if (s.proveedor_nit) {
    const nit = normNit(s.proveedor_nit)
    return { proveedor: m.proveedores.find((x) => x.nit === nit) ?? null, via: "nit" }
  }
  const nombre = normNombre(s.proveedor_nombre)
  return { proveedor: m.proveedores.find((x) => normNombre(x.nombre) === nombre) ?? null, via: "nombre" }
}

export function evaluar(m: Maestros, p: Paquete): Validacion {
  const s = p.solicitud
  const bloqueos: Hallazgo[] = []
  const confirmaciones: Hallazgo[] = []
  const observaciones: Hallazgo[] = []
  const derivados: Record<string, Derivado> = {}

  // RC1 proveedor
  const { proveedor, via } = buscarProveedor(m, p)
  if (!proveedor) {
    bloqueos.push({
      codigo: "RC1",
      detalle: `El proveedor "${s.proveedor_nombre}"${s.proveedor_nit ? ` (NIT ${s.proveedor_nit})` : ""} no existe en el maestro de proveedores.`,
      accion_sugerida: "Solicitar el alta del proveedor en SAP (RUT, cámara de comercio, certificación bancaria) antes de crear la OC.",
    })
  } else {
    if (!proveedor.activo)
      bloqueos.push({
        codigo: "RC1",
        detalle: `El proveedor ${proveedor.nombre} (${proveedor.codigo_sap}) está inactivo en el maestro.`,
        accion_sugerida: "Pedir a compras la reactivación del proveedor o usar uno activo.",
      })
    if (p.cotizacion?.nit && p.cotizacion.nit !== proveedor.nit)
      bloqueos.push({
        codigo: "RC1",
        detalle: `El NIT de la cotización (${p.cotizacion.nit}) no coincide con el del proveedor del maestro (${proveedor.nit}).`,
        accion_sugerida: "Confirmar con el solicitante a qué proveedor corresponde la compra.",
      })
    if (via === "nombre")
      observaciones.push({
        codigo: "RC1",
        detalle: `La solicitud no trae NIT: proveedor identificado por nombre como ${proveedor.nombre} (NIT ${proveedor.nit})${p.cotizacion?.nit === proveedor.nit ? ", verificado contra el NIT de la cotización" : ""}.`,
      })
  }

  // RC10 aritmética
  const calculado = s.cantidad * s.valor_unitario
  if (Math.abs(calculado - s.valor_total) > 1)
    bloqueos.push({
      codigo: "RC10",
      detalle: `cantidad × valor_unitario = ${fmt(calculado)} no coincide con valor_total ${fmt(s.valor_total)}.`,
      accion_sugerida: "Pedir al solicitante corregir cantidades o valores en el Excel.",
    })

  // RC4 centro y subárea
  const centro = m.centros.find((c) => c.centro_costo === s.centro_costo) ?? null
  if (!centro) {
    bloqueos.push({ codigo: "RC4", detalle: `El centro de costo ${s.centro_costo} no existe en el maestro.`, accion_sugerida: "Pedir el centro de costo correcto." })
  } else if (!centro.subareas.some((x) => normNombre(x) === normNombre(s.subarea))) {
    bloqueos.push({
      codigo: "RC4",
      detalle: `La subárea "${s.subarea}" no pertenece a ${centro.centro_costo} (${centro.subareas.join(", ")}).`,
      accion_sugerida: "Pedir al solicitante la subárea correcta.",
    })
  }

  // RC2 y RC3 aprobación
  const a = p.aprobacion
  if (!a) {
    bloqueos.push({ codigo: "RC2", detalle: "No hay correo de aprobación del líder.", accion_sugerida: "Pedir al solicitante el correo de aprobación." })
  } else {
    if (!a.aprobado)
      bloqueos.push({
        codigo: "RC2",
        detalle: `El correo de ${a.de} no contiene una aprobación explícita ("Aprobado").`,
        accion_sugerida: "Pedir al líder una aprobación explícita.",
      })
    if (centro) {
      const aprobador = centro.aprobadores.find((x) => normEmail(x.email) === normEmail(a.de)) ?? null
      const topeMax = Math.max(0, ...centro.aprobadores.map((x) => x.tope))
      if (!aprobador) {
        const otro = m.centros.find((c) => c.aprobadores.some((x) => normEmail(x.email) === normEmail(a.de)))
        const otroAprob = otro?.aprobadores.find((x) => normEmail(x.email) === normEmail(a.de))
        bloqueos.push({
          codigo: "RC2",
          detalle: `${a.de} no es aprobador de ${centro.centro_costo}${otro ? ` (es aprobador de ${otro.centro_costo} ${otro.nombre})` : ""}.`,
          accion_sugerida: `Obtener aprobación de: ${centro.aprobadores.map((x) => `${x.nombre} (tope ${fmt(x.tope)})`).join(", ")}.`,
        })
        if (topeMax < s.valor_total)
          bloqueos.push({
            codigo: "RC3",
            detalle: `Ningún aprobador de ${centro.centro_costo} tiene tope suficiente: valor ${fmt(s.valor_total)} > tope máximo ${fmt(topeMax)}.`,
            accion_sugerida: "Escalar la aprobación o revisar la matriz de topes.",
          })
        // ¿el texto sugiere otro centro? (ej. "preventa" → CC-3030)
        const texto = normNombre(a.texto)
        if (otro && otroAprob) {
          const sub = otro.subareas.find((x) => texto.includes(normNombre(x)))
          if (sub)
            observaciones.push({
              codigo: "RC2",
              detalle: `El texto de la aprobación menciona "${sub}": verificar si el centro correcto es ${otro.centro_costo}/${sub} (${otroAprob.email}, tope ${fmt(otroAprob.tope)}) o escalar la aprobación en ${centro.centro_costo} (tope máximo ${fmt(topeMax)}).`,
            })
        }
      } else if (s.valor_total > aprobador.tope) {
        bloqueos.push({
          codigo: "RC3",
          detalle: `Valor ${fmt(s.valor_total)} supera el tope de ${aprobador.nombre} (${fmt(aprobador.tope)}) en ${centro.centro_costo}.`,
          accion_sugerida:
            topeMax >= s.valor_total
              ? `Pedir aprobación a ${centro.aprobadores.filter((x) => x.tope >= s.valor_total).map((x) => x.nombre).join(", ")}.`
              : "Escalar: ningún aprobador del centro tiene tope suficiente.",
        })
      }
    }
    // RC9 fecha de aprobación
    const fAprob = a.fecha.slice(0, 10)
    if (!/^\d{4}-\d{2}-\d{2}$/.test(fAprob))
      confirmaciones.push({ codigo: "RC9", detalle: "La aprobación no tiene fecha legible." })
    else if (fAprob < s.fecha_solicitud)
      confirmaciones.push({
        codigo: "RC9",
        detalle: `La aprobación (${fAprob}) es anterior a la solicitud (${s.fecha_solicitud}).`,
      })
  }

  // RC5 cotización vs solicitud (+ monto limitado en la aprobación)
  const c = p.cotizacion
  if (!c) {
    confirmaciones.push({ codigo: "RC5", detalle: "No hay cotización del proveedor en el paquete." })
  } else {
    const desv = Math.abs(c.total - s.valor_total) / s.valor_total
    const partes: string[] = []
    if (c.moneda !== s.moneda) partes.push(`moneda de la cotización (${c.moneda}) distinta a la de la solicitud (${s.moneda})`)
    if (desv > 0.02)
      partes.push(
        `cotización ${fmt(c.total)} vs solicitud ${fmt(s.valor_total)} (desviación ${(desv * 100).toFixed(1).replace(".", ",")} %, máximo 2 %)`,
      )
    const limite = a ? montoAprobado(a.texto) : null
    if (partes.length > 0) {
      let detalle = partes.join("; ")
      if (limite !== null && c.total > limite)
        detalle += `. La aprobación cubre ${fmt(limite)}; crear por ${fmt(c.total)} requiere nueva aprobación. Recomendación: crear por el valor aprobado (${fmt(s.valor_total)}) o pedir re-aprobación.`
      confirmaciones.push({
        codigo: "RC5",
        detalle,
        accion_sugerida: "La OC se construye con el valor de la solicitud (el aprobado); confirmar o pedir re-aprobación por el valor cotizado.",
      })
    }
    if (c.validez_hasta && c.validez_hasta < s.fecha_solicitud)
      observaciones.push({ codigo: "COTIZACION_VENCIDA", detalle: `La cotización venció el ${c.validez_hasta}, antes de la solicitud.` })
  }

  // RC6 indicador IVA
  if (!s.indicador_iva) {
    if (proveedor) {
      derivados.indicador_iva = {
        valor: proveedor.indicador_iva_default,
        fuente: "maestro.proveedores",
        detalle: `indicador_iva_default de ${proveedor.nombre}`,
      }
      confirmaciones.push({
        codigo: "RC6",
        detalle: `La solicitud no informa indicador de IVA; se propone ${proveedor.indicador_iva_default} (${m.iva.find((x) => x.codigo === proveedor.indicador_iva_default)?.descripcion ?? "?"}) desde el maestro del proveedor.`,
      })
    }
  } else if (!m.iva.some((x) => x.codigo === s.indicador_iva)) {
    bloqueos.push({ codigo: "MAESTRO_IVA", detalle: `El indicador de IVA ${s.indicador_iva} no existe en el maestro.`, accion_sugerida: "Pedir el indicador correcto." })
  }

  // RC7 condiciones de pago
  if (!s.condiciones_pago) {
    if (proveedor)
      derivados.condiciones_pago = {
        valor: proveedor.condiciones_pago_default,
        fuente: "maestro.proveedores",
        detalle: `condiciones_pago_default de ${proveedor.nombre} (${m.pagos.find((x) => x.codigo === proveedor.condiciones_pago_default)?.descripcion ?? "?"})`,
      }
  } else if (!m.pagos.some((x) => x.codigo === s.condiciones_pago)) {
    bloqueos.push({ codigo: "MAESTRO_PAGO", detalle: `La condición de pago ${s.condiciones_pago} no existe en el maestro.`, accion_sugerida: "Pedir la condición correcta." })
  }

  // RC8 retroactiva
  const retroactiva = p.factura !== null && p.factura.fecha < s.fecha_solicitud
  if (retroactiva && p.factura)
    confirmaciones.push({
      codigo: "RC8",
      detalle: `OC retroactiva: la factura ${p.factura.numero} (${p.factura.fecha}) es anterior a la solicitud (${s.fecha_solicitud}). Quedará marcada en el control.`,
    })

  // Observación de segregación de funciones: el solicitante es la misma persona que recibe en compras
  const saludo = p.correo.cuerpo.match(/^\s*Hola\s+([A-Za-zÁÉÍÓÚÑáéíóúñ]+)/)?.[1]
  const nombreSolicitante = s.solicitante.split(/\s+/)[0]
  if (saludo && normNombre(saludo) === normNombre(nombreSolicitante))
    observaciones.push({
      codigo: "SEGREGACION",
      detalle: `La solicitante (${s.solicitante}) parece ser la misma persona de compras que crea la OC ("Hola ${saludo}"): posible conflicto de segregación de funciones. Sugerido: que otra persona cree o revise esta OC.`,
    })

  return { apta: bloqueos.length === 0, bloqueos, confirmaciones, derivados, retroactiva, observaciones }
}

// ---------- evidencia (HU-4) ----------
export function textoEvidencia(caso: string, dir: string): Resultado<{ contenido: string; sha256: string; campos: Record<string, string> }> {
  const ruta = join(fixturesDir(dir), "solicitudes", caso, "aprobacion.json")
  if (!existsSync(ruta)) return { ok: false, error: "No hay correo de aprobación: pedir al solicitante el correo del líder." }
  let a: AprobacionRaw
  try {
    a = leerJson(ruta) as AprobacionRaw
  } catch {
    return { ok: false, error: "aprobacion.json malformado." }
  }
  const campos = { de: a.de ?? "", para: a.para ?? "", fecha: a.fecha ?? "", asunto: a.asunto ?? "" }
  const contenido = `De: ${campos.de}\nPara: ${campos.para}\nFecha: ${campos.fecha}\nAsunto: ${campos.asunto}\n\n${a.cuerpo ?? ""}\n`
  const sha256 = createHash("sha256").update(contenido, "utf8").digest("hex")
  return { ok: true, data: { contenido, sha256, campos } }
}

// ---------- payload (HU-3) ----------
export type Traza = { valor: unknown; fuente: string; nota?: string }

export function construir(
  dir: string,
  caso: string,
  m: Maestros,
  p: Paquete,
  v: Validacion,
): Resultado<{ payload: OrdenCompra; trazabilidad: Record<string, Traza>; resumen: Record<string, number> }> {
  if (!v.apta) return { ok: false, error: `No se construye la OC: hay bloqueos (${v.bloqueos.map((b) => `${b.codigo}: ${b.detalle}`).join(" | ")}).` }
  const s = p.solicitud
  const { proveedor } = buscarProveedor(m, p)
  if (!proveedor) return { ok: false, error: "Proveedor no encontrado." }
  if (s.moneda !== "COP" && s.moneda !== "USD") return { ok: false, error: `Moneda ${s.moneda} no soportada por la OC (COP o USD).` }
  const ev = textoEvidencia(caso, dir)
  if (!ev.ok) return ev
  const a = p.aprobacion
  if (!a) return { ok: false, error: "Falta aprobación." }

  const iva = s.indicador_iva ?? v.derivados.indicador_iva?.valor ?? ""
  const tasa = m.iva.find((x) => x.codigo === iva)?.tasa
  if (tasa === undefined) return { ok: false, error: `Indicador de IVA ${iva || "(vacío)"} no resoluble.` }
  const pago = s.condiciones_pago ?? v.derivados.condiciones_pago?.valor ?? ""
  const precioBase = round2(s.valor_unitario / (1 + tasa))
  const truncada = s.descripcion.length > 40
  const descripcion = truncada ? s.descripcion.slice(0, 40).trimEnd() : s.descripcion
  const unidad: "UN" | "H" | "MES" = /\bhoras?\b/i.test(s.descripcion) ? "H" : /\bmes(es)?\b|mensual/i.test(s.descripcion) && !/\d+\s*meses/i.test(s.descripcion) ? "MES" : "UN"

  const excepciones: OrdenCompra["excepciones"] = v.confirmaciones.map((x) => ({ codigo: x.codigo, detalle: x.detalle, confirmado_por: null }))
  if (truncada) excepciones.push({ codigo: "TEXTO_TRUNCADO", detalle: `Descripción recortada a 40 caracteres; texto completo: "${s.descripcion}"`, confirmado_por: null })
  if (v.derivados.condiciones_pago)
    excepciones.push({ codigo: "RC7", detalle: `Condiciones de pago derivadas del maestro: ${pago}`, confirmado_por: null })

  const payload: OrdenCompra = {
    referencia: { solicitud_id: s.solicitud_id, correo_id: p.correo.id, cotizacion_ref: p.cotizacion?.numero ?? null },
    sociedad: "1000",
    organizacion_compras: "1000",
    proveedor: { codigo_sap: proveedor.codigo_sap, nit: proveedor.nit, nombre: proveedor.nombre },
    moneda: s.moneda,
    condiciones_pago: pago,
    aprobador: { email: normEmail(a.de), fecha_aprobacion: a.fecha.slice(0, 10), evidencia_sha256: ev.data.sha256 },
    posiciones: [
      {
        numero: 10,
        descripcion,
        cantidad: s.cantidad,
        unidad,
        precio_unitario: precioBase,
        centro_costo: s.centro_costo,
        subarea: s.subarea,
        indicador_iva: iva,
      },
    ],
    excepciones,
  }
  const valid = OrdenCompraSchema.safeParse(payload)
  if (!valid.success) return { ok: false, error: `Payload inválido: ${valid.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}` }

  const trazabilidad: Record<string, Traza> = {
    "referencia.solicitud_id": { valor: s.solicitud_id, fuente: "solicitud" },
    "referencia.correo_id": { valor: p.correo.id, fuente: "correo" },
    "referencia.cotizacion_ref": { valor: p.cotizacion?.numero ?? null, fuente: "cotizacion" },
    sociedad: { valor: "1000", fuente: "derivado", nota: "constante del PRD" },
    organizacion_compras: { valor: "1000", fuente: "derivado", nota: "constante del PRD" },
    "proveedor.codigo_sap": { valor: proveedor.codigo_sap, fuente: "maestro.proveedores" },
    "proveedor.nit": { valor: proveedor.nit, fuente: "maestro.proveedores" },
    "proveedor.nombre": { valor: proveedor.nombre, fuente: "maestro.proveedores" },
    moneda: { valor: s.moneda, fuente: "solicitud" },
    condiciones_pago: { valor: pago, fuente: s.condiciones_pago ? "solicitud" : "maestro.proveedores" },
    "aprobador.email": { valor: payload.aprobador.email, fuente: "aprobacion" },
    "aprobador.fecha_aprobacion": { valor: payload.aprobador.fecha_aprobacion, fuente: "aprobacion" },
    "aprobador.evidencia_sha256": { valor: ev.data.sha256, fuente: "derivado", nota: "sha256 del texto de evidencia" },
    "posiciones[0].descripcion": { valor: descripcion, fuente: "solicitud", nota: truncada ? `truncada; original: ${s.descripcion}` : undefined },
    "posiciones[0].cantidad": { valor: s.cantidad, fuente: "solicitud" },
    "posiciones[0].unidad": { valor: unidad, fuente: "derivado", nota: "inferida de la descripción" },
    "posiciones[0].precio_unitario": {
      valor: precioBase,
      fuente: "derivado",
      nota: `valor_unitario de la solicitud ${s.valor_unitario} (IVA incluido) ÷ (1 + ${tasa}); SAP suma el IVA según el indicador`,
    },
    "posiciones[0].centro_costo": { valor: s.centro_costo, fuente: "solicitud" },
    "posiciones[0].subarea": { valor: s.subarea, fuente: "solicitud" },
    "posiciones[0].indicador_iva": { valor: iva, fuente: s.indicador_iva ? "solicitud" : "maestro.proveedores" },
  }
  const baseTotal = round2(precioBase * s.cantidad)
  return {
    ok: true,
    data: {
      payload: valid.data,
      trazabilidad,
      resumen: { valor_bruto_total: s.valor_total, base_total: baseTotal, iva_estimado: round2(s.valor_total - baseTotal) },
    },
  }
}

/** JSON canónico (claves ordenadas) para comparar el payload recibido con el reconstruido. */
export function canonico(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonico).join(",")}]`
  if (v && typeof v === "object") {
    const o = v as Record<string, unknown>
    return `{${Object.keys(o)
      .filter((k) => o[k] !== undefined)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonico(o[k])}`)
      .join(",")}}`
  }
  return JSON.stringify(v)
}

/** Ignora confirmado_por (lo asigna el backend al confirmar) al comparar payloads. */
export function sinConfirmadoPor(payload: unknown): unknown {
  if (!payload || typeof payload !== "object") return payload
  const o = { ...(payload as Record<string, unknown>) }
  if (Array.isArray(o.excepciones))
    o.excepciones = (o.excepciones as unknown[]).map((e) =>
      e && typeof e === "object" ? { ...(e as Record<string, unknown>), confirmado_por: null } : e,
    )
  return o
}

// Herramientas del agente "Registro de Contratos Vigentes". Cada export → contratos_<export>.
// Son la única fuente de valores que el agente puede afirmar. Ninguna lanza excepciones.
import { z } from "zod/v4"
import { appendJsonl, defineTool, errorMessage, fail, fechaReferencia, ok, type ToolCtx } from "../core/tool"
import { ErrorExtraccion, esFechaValida, extraerContrato, type ContratoExtraido } from "../contratos/extraccion"
import {
  adjuntoContrato, archivar, asegurarMaestro, comerciales, escribirCsv, leerCorreo, leerCsv, leerMaestro,
  leerProcesados, listarMensajes, marcarProcesado, rutas, type Correo, type Fila,
} from "../contratos/repositorio"
import { aplicarPropuesta, clasificar, filaNueva, idAutomatico, slugCliente, valoresDe, type Validacion, type Valores } from "../contratos/reglas"
import { generarAlertas } from "../contratos/alertas"
import { mkdirSync, writeFileSync } from "node:fs"
import { dirname } from "node:path"

/** RN7: evento de negocio por mensaje en out/log.jsonl (el core registra además la llamada técnica con sessionId). */
function registrarEvento(ctx: ToolCtx, herramienta: string, mensajeId: string | null, resultado: string): string {
  try {
    const r = JSON.parse(resultado) as { ok: boolean; data?: unknown; error?: string }
    appendJsonl(rutas(ctx.directory).log, {
      ts: new Date().toISOString(),
      herramienta: `contratos_${herramienta}`,
      mensaje_id: mensajeId,
      ok: r.ok,
      resumen: r.ok ? JSON.stringify(r.data).slice(0, 200) : r.error,
      nivel: "negocio",
    })
  } catch {
    /* el log nunca tumba la herramienta */
  }
  return resultado
}

const mensajeIdArg = z.string().min(1).describe("Id de la carpeta del mensaje en fixtures/reto-02/buzon/, por ejemplo msg-001")
const contratoArg = z
  .record(z.string(), z.unknown())
  .optional()
  .describe("Valores del contrato (planos o {valor, confianza}). Si se omite se usa la extracción de contratos_extraer. Valores que difieran de la extracción requieren confirmación humana.")

type Preparado =
  | { tipo: "rechazado"; correo: Correo; motivo: string }
  | { tipo: "contrato"; correo: Correo; extraido: ContratoExtraido; ruta: string; nombre: string }

/** Lee correo + adjunto y extrae. Un mensaje sin contrato se devuelve como rechazado (RN4), no como error. */
function preparar(dir: string, mensajeId: string): Preparado {
  const correo = leerCorreo(dir, mensajeId)
  const adj = adjuntoContrato(dir, correo)
  if (!adj) {
    const adjuntos = correo.adjuntos.length ? correo.adjuntos.join(", ") : "ninguno"
    return { tipo: "rechazado", correo, motivo: `Sin adjunto de contrato (adjuntos: ${adjuntos}).` }
  }
  try {
    return { tipo: "contrato", correo, extraido: extraerContrato(adj.texto, correo.fecha.slice(0, 10)), ruta: adj.ruta, nombre: adj.nombre }
  } catch (e) {
    if (e instanceof ErrorExtraccion) return { tipo: "rechazado", correo, motivo: e.message }
    throw e
  }
}

function validacionRechazo(correo: Correo, motivo: string, dir: string): Validacion {
  const c = comerciales(dir).find((x) => x.email.toLowerCase() === correo.de.toLowerCase())
  return {
    clasificacion: "rechazado",
    requiere_revision: [],
    diferencias: [],
    comercial: { email: correo.de, nombre: c?.nombre ?? null, registrado: Boolean(c) },
    advertencias: [],
    motivo,
  }
}

export const leer_buzon = defineTool({
  description: "Lista los mensajes del buzón de contratos que aún no se han procesado, indicando si traen un contrato adjunto.",
  args: {},
  async execute(_args, ctx) {
    try {
      const procesados = leerProcesados(ctx.directory)
      const mensajes = listarMensajes(ctx.directory)
        .filter((id) => !procesados[id])
        .map((id) => {
          const correo = leerCorreo(ctx.directory, id)
          const tiene = adjuntoContrato(ctx.directory, correo) !== null
          return {
            id: correo.id, de: correo.de, asunto: correo.asunto, fecha: correo.fecha, adjuntos: correo.adjuntos,
            tiene_contrato: tiene,
            ...(tiene ? {} : { clasificacion: "rechazado", motivo: "Sin adjunto de contrato (RN4)." }),
          }
        })
      return registrarEvento(ctx, "leer_buzon", null, ok({ mensajes, ya_procesados: Object.keys(procesados) }))
    } catch (e) {
      return registrarEvento(ctx, "leer_buzon", null, fail(`No se pudo leer el buzón: ${errorMessage(e)}`))
    }
  },
})

export const extraer = defineTool({
  description: "Extrae del contrato adjunto a un mensaje sus datos estructurados con nivel de confianza por campo (extracción determinista, sin inventar).",
  args: { mensaje_id: mensajeIdArg },
  async execute({ mensaje_id }, ctx) {
    try {
      const correo = leerCorreo(ctx.directory, mensaje_id)
      const adj = adjuntoContrato(ctx.directory, correo)
      if (!adj) return registrarEvento(ctx, "extraer", mensaje_id, fail(`El mensaje ${mensaje_id} no trae contrato (adjuntos: ${correo.adjuntos.join(", ") || "ninguno"}). Clasifícalo como rechazado.`))
      const contrato = extraerContrato(adj.texto, correo.fecha.slice(0, 10))
      return registrarEvento(ctx, "extraer", mensaje_id, ok({ mensaje_id, adjunto: adj.nombre, contrato }))
    } catch (e) {
      return registrarEvento(ctx, "extraer", mensaje_id, fail(`No se pudo extraer ${mensaje_id}: ${errorMessage(e)}`))
    }
  },
})

function validarInterno(dir: string, mensajeId: string, propuesta: Record<string, unknown> | undefined) {
  const prep = preparar(dir, mensajeId)
  if (prep.tipo === "rechazado") return { prep, validacion: validacionRechazo(prep.correo, prep.motivo, dir), valores: null, correcciones: [] }
  const base = valoresDe(prep.extraido)
  const aplicada = aplicarPropuesta(base, propuesta)
  if ("error" in aplicada) return { error: aplicada.error }
  const validacion = clasificar(prep.extraido, aplicada.valores, leerMaestro(dir), prep.correo.de, comerciales(dir), aplicada.correcciones)
  return { prep, validacion, valores: aplicada.valores, correcciones: aplicada.correcciones }
}

export const validar = defineTool({
  description: "Clasifica un contrato como nuevo, actualización, duplicado o rechazado frente al maestro y lista los campos que requieren revisión humana.",
  args: { mensaje_id: mensajeIdArg, contrato: contratoArg },
  async execute({ mensaje_id, contrato }, ctx) {
    try {
      const r = validarInterno(ctx.directory, mensaje_id, contrato)
      if ("error" in r) return registrarEvento(ctx, "validar", mensaje_id, fail(r.error ?? "error de validación"))
      return registrarEvento(ctx, "validar", mensaje_id, ok({ mensaje_id, ...r.validacion }))
    } catch (e) {
      return registrarEvento(ctx, "validar", mensaje_id, fail(`No se pudo validar ${mensaje_id}: ${errorMessage(e)}`))
    }
  },
})

function escribirRegistro(
  ctx: ToolCtx,
  mensajeId: string,
  prep: Extract<Preparado, { tipo: "contrato" }>,
  validacion: Validacion,
  valores: Valores,
  extra: Record<string, unknown>,
) {
  const dir = ctx.directory
  const ruta = asegurarMaestro(dir)
  const maestro = leerCsv(ruta)
  const hoy = fechaReferencia()
  const ts = new Date().toISOString()
  if (validacion.clasificacion === "actualizacion") {
    const fila = maestro.find((r) => r.id_contrato === validacion.id_contrato_existente) as Fila
    for (const d of validacion.diferencias) (fila as Record<string, string>)[d.campo] = d.despues
    const anio = fila.fecha_inicio.slice(0, 4) || hoy.slice(0, 4)
    const sufijo = prep.extraido.es_otrosi ? `-otrosi-${mensajeId}` : `-${mensajeId}`
    const archivo = archivar(dir, prep.ruta, anio, slugCliente(fila.cliente), `${fila.id_contrato}${sufijo}.txt`)
    escribirCsv(ruta, maestro)
    appendJsonl(rutas(dir).historial, { ts, id_contrato: fila.id_contrato, accion: "actualizacion", cambios: validacion.diferencias, mensaje_id: mensajeId, documento: archivo, ...extra })
    return { id_contrato: fila.id_contrato, accion: "actualizacion", ruta_archivo: archivo, cambios: validacion.diferencias }
  }
  const anio = String(valores.fecha_inicio ?? hoy).slice(0, 4)
  const id = typeof valores.id_contrato === "string" ? valores.id_contrato : idAutomatico(maestro, anio)
  const archivo = archivar(dir, prep.ruta, anio, slugCliente(valores.cliente), `${id}.txt`)
  const fila = filaNueva(valores, validacion.comercial, archivo, hoy, id)
  maestro.push(fila)
  escribirCsv(ruta, maestro)
  appendJsonl(rutas(dir).historial, { ts, id_contrato: id, accion: "nuevo", cambios: fila, mensaje_id: mensajeId, ...extra })
  return { id_contrato: id, accion: "nuevo", ruta_archivo: archivo, estado_poliza: fila.estado_poliza }
}

export const registrar = defineTool({
  description: "Escribe el contrato en el maestro simulado de SharePoint y archiva el documento; si hay campos en revisión solo procede con confirmado=true.",
  args: {
    mensaje_id: mensajeIdArg,
    contrato: contratoArg,
    confirmado: z.boolean().optional().describe("true solo si el usuario confirmó explícitamente en su último mensaje los campos en revisión"),
  },
  async execute({ mensaje_id, contrato, confirmado }, ctx) {
    const dir = ctx.directory
    try {
      const r = validarInterno(dir, mensaje_id, contrato)
      if ("error" in r) return registrarEvento(ctx, "registrar", mensaje_id, fail(r.error ?? "error de validación"))
      const { prep, validacion, valores, correcciones } = r
      const ts = new Date().toISOString()
      if (prep.tipo === "rechazado" || validacion.clasificacion === "duplicado" || !valores) {
        const id = validacion.id_contrato_existente ?? null
        marcarProcesado(dir, mensaje_id, { clasificacion: validacion.clasificacion, id_contrato: id, accion: "sin_escritura", ts })
        return registrarEvento(ctx, "registrar", mensaje_id, ok({ id_contrato: id, accion: "sin_escritura", clasificacion: validacion.clasificacion, motivo: validacion.motivo }))
      }
      if (validacion.requiere_revision.length && confirmado !== true) {
        return registrarEvento(ctx, "registrar", mensaje_id, fail(`requiere revisión: ${validacion.requiere_revision.join("; ")}. Pide confirmación al usuario campo por campo y vuelve a llamar con confirmado=true.`))
      }
      const extra = {
        ...(validacion.requiere_revision.length ? { confirmado_por_humano: validacion.requiere_revision } : {}),
        ...(correcciones.length ? { correccion_humana: correcciones } : {}),
        ...(validacion.comercial.registrado ? {} : { remitente_no_registrado: validacion.comercial.email }),
      }
      const res = escribirRegistro(ctx, mensaje_id, prep, validacion, valores, extra)
      marcarProcesado(dir, mensaje_id, { clasificacion: validacion.clasificacion, id_contrato: res.id_contrato, accion: res.accion, ts })
      return registrarEvento(ctx, "registrar", mensaje_id, ok({ ...res, clasificacion: validacion.clasificacion, advertencias: validacion.advertencias }))
    } catch (e) {
      return registrarEvento(ctx, "registrar", mensaje_id, fail(`No se pudo registrar ${mensaje_id}: ${errorMessage(e)}`))
    }
  },
})

export const alertas = defineTool({
  description: "Genera out/alertas.md con contratos que vencen en 60 días o menos, pólizas pendientes y contratos registrados desde el corte del 2026-05-30.",
  args: { hoy: z.string().describe("Fecha de referencia YYYY-MM-DD (se pasa explícita para que el reporte sea determinista)") },
  async execute({ hoy }, ctx) {
    try {
      if (!esFechaValida(hoy)) return registrarEvento(ctx, "alertas", null, fail(`Fecha inválida: "${hoy}". Usa el formato YYYY-MM-DD.`))
      const resultado = generarAlertas(leerMaestro(ctx.directory), hoy, rutas(ctx.directory).historial)
      mkdirSync(dirname(rutas(ctx.directory).alertas), { recursive: true })
      writeFileSync(rutas(ctx.directory).alertas, resultado.markdown, "utf8")
      const { markdown: _md, ...data } = resultado
      return registrarEvento(ctx, "alertas", null, ok({ ruta: "out/alertas.md", ...data }))
    } catch (e) {
      return registrarEvento(ctx, "alertas", null, fail(`No se pudo generar el reporte de alertas: ${errorMessage(e)}`))
    }
  },
})

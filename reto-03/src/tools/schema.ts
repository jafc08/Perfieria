// Esquemas zod del reto 03: solicitud de entrada, paquete normalizado (7.2) y OrdenCompra (7.4).
import { z } from "zod/v4"

export const SolicitudSchema = z.object({
  solicitud_id: z.string().min(1),
  solicitante: z.string().min(1),
  proveedor_nombre: z.string().min(1),
  proveedor_nit: z.string().optional(),
  descripcion: z.string().min(1),
  centro_costo: z.string().min(1),
  subarea: z.string().min(1),
  cantidad: z.number({ error: "cantidad debe ser numérica" }),
  valor_unitario: z.number({ error: "valor_unitario debe ser numérico" }),
  valor_total: z.number({ error: "valor_total debe ser numérico" }),
  moneda: z.string().min(1),
  indicador_iva: z.string().optional(),
  condiciones_pago: z.string().optional(),
  fecha_solicitud: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "fecha_solicitud debe ser YYYY-MM-DD"),
})
export type Solicitud = z.infer<typeof SolicitudSchema>

export type Paquete = {
  correo: { id: string; de: string; asunto: string; fecha: string; cuerpo: string }
  solicitud: Solicitud
  cotizacion: {
    proveedor: string
    nit: string | null
    total: number
    moneda: string
    validez_hasta: string | null
    texto: string
    numero: string | null
    fecha: string | null
  } | null
  aprobacion: { de: string; para: string; asunto: string; fecha: string; aprobado: boolean; texto: string } | null
  factura: { numero: string; fecha: string; total: number } | null
  faltantes: string[]
}

export const OrdenCompraSchema = z.object({
  referencia: z.object({
    solicitud_id: z.string(),
    correo_id: z.string(),
    cotizacion_ref: z.string().nullable(),
  }),
  sociedad: z.literal("1000"),
  organizacion_compras: z.literal("1000"),
  proveedor: z.object({ codigo_sap: z.string(), nit: z.string(), nombre: z.string() }),
  moneda: z.enum(["COP", "USD"]),
  condiciones_pago: z.string(),
  aprobador: z.object({ email: z.string(), fecha_aprobacion: z.string(), evidencia_sha256: z.string() }),
  posiciones: z
    .array(
      z.object({
        numero: z.number(),
        descripcion: z.string().max(40),
        cantidad: z.number(),
        unidad: z.enum(["UN", "H", "MES"]),
        precio_unitario: z.number(),
        centro_costo: z.string(),
        subarea: z.string(),
        indicador_iva: z.string(),
      }),
    )
    .min(1),
  excepciones: z.array(z.object({ codigo: z.string(), detalle: z.string(), confirmado_por: z.string().nullable() })),
})
export type OrdenCompra = z.infer<typeof OrdenCompraSchema>

export type Hallazgo = { codigo: string; detalle: string; accion_sugerida?: string }
export type Derivado = { valor: string; fuente: string; detalle: string }

export type Validacion = {
  apta: boolean
  bloqueos: Hallazgo[]
  confirmaciones: Hallazgo[]
  derivados: Record<string, Derivado>
  retroactiva: boolean
  observaciones: Hallazgo[]
}

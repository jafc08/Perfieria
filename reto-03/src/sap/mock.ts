// SAP simulado: escribe en <directory>/out/sap/ordenes.jsonl y asigna números desde 4500000001.
import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { appendJsonl } from "../core/tool"
import type { SapAdapter } from "./adapter"
import type { OrdenCompra } from "../tools/schema"

type ProveedorMaestro = { codigo_sap: string; nit: string; activo: boolean }
type OrdenGuardada = { numero_oc: string; fecha: string; solicitud_id: string; orden: OrdenCompra }

const PRIMER_NUMERO = 4500000001

export class SapMock implements SapAdapter {
  constructor(private readonly directory: string) {}

  private get ordenesPath(): string {
    return join(this.directory, "out", "sap", "ordenes.jsonl")
  }

  private leerOrdenes(): OrdenGuardada[] {
    if (!existsSync(this.ordenesPath)) return []
    return readFileSync(this.ordenesPath, "utf8")
      .split("\n")
      .filter((l) => l.trim().length > 0)
      .map((l) => JSON.parse(l) as OrdenGuardada)
  }

  async consultarProveedor(nit: string): Promise<{ codigo_sap: string; activo: boolean } | null> {
    const ruta = join(this.directory, "fixtures", "reto-03", "maestros", "proveedores.json")
    const proveedores = JSON.parse(readFileSync(ruta, "utf8")) as ProveedorMaestro[]
    const p = proveedores.find((x) => x.nit === nit)
    return p ? { codigo_sap: p.codigo_sap, activo: p.activo } : null
  }

  async crearOrden(orden: OrdenCompra): Promise<{ numero_oc: string; fecha: string }> {
    const ordenes = this.leerOrdenes()
    const numero_oc = String(PRIMER_NUMERO + ordenes.length)
    const fecha = new Date().toISOString().slice(0, 10)
    appendJsonl(this.ordenesPath, { numero_oc, fecha, solicitud_id: orden.referencia.solicitud_id, orden })
    return { numero_oc, fecha }
  }

  /** Fecha de creación de una OC existente (auxiliar del mock, fuera de la interfaz). */
  fechaDe(solicitud_id: string): string | null {
    return this.leerOrdenes().find((x) => x.solicitud_id === solicitud_id)?.fecha ?? null
  }

  async buscarOrdenPorReferencia(solicitud_id: string): Promise<{ numero_oc: string } | null> {
    const o = this.leerOrdenes().find((x) => x.solicitud_id === solicitud_id)
    return o ? { numero_oc: o.numero_oc } : null
  }
}

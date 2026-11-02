// Configuración del agente de este reto (lo único que cambia entre retos además de herramientas, prompt y conocimiento).
import { fileURLToPath } from "node:url"
import * as herramientas from "./tools/proveedor"
import type { AgentConfig } from "./agent/loop"

export const config: AgentConfig = {
  id: "reto-01",
  titulo: "Registro como Proveedor",
  directory: fileURLToPath(new URL("..", import.meta.url)).replace(/\/$/, ""),
  prefix: "proveedor",
  toolsModule: herramientas,
  gatedTools: ["proveedor_simular_envio"],
  ejemplo:
    'Procesa el caso "ec-corp-andina". Dime qué campos quedaron llenos, cuáles faltan, si el paquete está listo para firma y qué soportes debo actualizar. No envíes nada todavía.',
}

// Configuración del agente de este reto (lo único que cambia entre retos además de herramientas, prompt y conocimiento).
import { fileURLToPath } from "node:url"
import * as herramientas from "./tools/oc"
import type { AgentConfig } from "./agent/loop"

export const config: AgentConfig = {
  id: "reto-03",
  titulo: "Órdenes de Compra SAP",
  directory: fileURLToPath(new URL("..", import.meta.url)).replace(/\/$/, ""),
  prefix: "oc",
  toolsModule: herramientas,
  gatedTools: ["oc_crear"],
  ejemplo:
    'Procesa la solicitud "sol-004". Muéstrame la OC como quedaría en SAP, qué validaciones pasó y cuáles no, y no la crees hasta que yo lo confirme.',
}

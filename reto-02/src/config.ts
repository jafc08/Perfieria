// Configuración del agente de este reto (lo único que cambia entre retos además de herramientas, prompt y conocimiento).
import { fileURLToPath } from "node:url"
import * as herramientas from "./tools/contratos"
import type { AgentConfig } from "./agent/loop"

export const config: AgentConfig = {
  id: "reto-02",
  titulo: "Registro de Contratos Vigentes",
  directory: fileURLToPath(new URL("..", import.meta.url)).replace(/\/$/, ""),
  prefix: "contratos",
  toolsModule: herramientas,
  gatedTools: ["contratos_registrar"],
  ejemplo:
    "Procesa el buzón de contratos con fecha de hoy 2026-09-03. Registra lo que esté limpio, muéstrame lo que requiere revisión campo por campo y termina con el reporte de alertas. No registres nada dudoso sin preguntarme.",
}

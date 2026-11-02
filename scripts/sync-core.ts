// Copia el núcleo compartido (_core) a cada reto para que cada carpeta sea entregable por sí sola.
import { cpSync, mkdirSync } from "node:fs"
import { join } from "node:path"

const root = join(import.meta.dir, "..")
const archivos = ["src/core/tool.ts", "src/llm/adapter.ts", "src/llm/anthropic.ts", "src/agent/loop.ts", "src/http.ts", "src/server.ts", "web/index.html"]
for (const reto of ["reto-01", "reto-02", "reto-03"]) {
  for (const f of archivos) {
    const destino = join(root, reto, f)
    mkdirSync(join(destino, ".."), { recursive: true })
    cpSync(join(root, "_core", f), destino)
  }
  console.log(`núcleo sincronizado → ${reto}`)
}

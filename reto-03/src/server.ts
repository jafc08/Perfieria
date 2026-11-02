// Arranque independiente de este reto: bun run src/server.ts
import { crearApp } from "./http"
import { config } from "./config"

const app = crearApp(config)
const port = Number(process.env.PORT ?? 3000)

Bun.serve({
  port,
  idleTimeout: 255,
  fetch(req) {
    return app.handle(req, new URL(req.url).pathname)
  },
})

console.log(`${config.titulo} → http://localhost:${port}  (modelo: ${app.agent.provider}/${app.agent.model})`)

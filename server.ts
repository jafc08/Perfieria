// Servidor único del despliegue: sirve los tres agentes en /reto-01, /reto-02 y /reto-03.
import { crearApp } from "./reto-01/src/http"
import { config as c1 } from "./reto-01/src/config"
import { crearApp as crearApp2 } from "./reto-02/src/http"
import { config as c2 } from "./reto-02/src/config"
import { crearApp as crearApp3 } from "./reto-03/src/http"
import { config as c3 } from "./reto-03/src/config"

const apps = { "reto-01": crearApp(c1), "reto-02": crearApp2(c2), "reto-03": crearApp3(c3) }
const port = Number(process.env.PORT ?? 3000)

const portada = `<!doctype html><html lang="es"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Retos IA · Periferia IT Group</title>
<body style="font:16px system-ui;max-width:720px;margin:48px auto;padding:0 20px;color:#1d2433"><h1 style="font-size:22px">Retos IA · Periferia IT Group</h1>
<p>Tres agentes conversacionales con el mismo núcleo (ciclo del agente, confirmación humana forzada en backend, herramientas tipadas con zod).</p>
<ul style="line-height:2">${Object.entries(apps).map(([k, a]) => `<li><a href="/${k}/">${k} · ${a.cfg.titulo}</a></li>`).join("")}</ul>
<p style="color:#667085;font-size:14px">Salud: ${Object.keys(apps).map((k) => `<a href="/${k}/api/health">${k}</a>`).join(" · ")}</p></body></html>`

Bun.serve({
  port,
  idleTimeout: 255,
  fetch(req) {
    const { pathname } = new URL(req.url)
    if (pathname === "/" ) return new Response(portada, { headers: { "content-type": "text/html; charset=utf-8" } })
    if (pathname === "/api/health") return Response.json({ ok: true, retos: Object.keys(apps) })
    const m = pathname.match(/^\/(reto-0[123])(\/.*)?$/)
    if (!m) return new Response("No encontrado", { status: 404 })
    const app = apps[m[1] as keyof typeof apps]
    if (!m[2]) return Response.redirect(new URL(`/${m[1]}/`, req.url).toString(), 301)
    return app.handle(req, m[2])
  },
})
console.log(`Retos IA → http://localhost:${port}  (/reto-01, /reto-02, /reto-03)`)

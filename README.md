# Retos IA · Periferia IT Group (Perxia 2.0)

Tres agentes conversacionales en TypeScript (Bun) con el **mismo núcleo**:

| Reto | Ruta | Herramientas | Acción controlada por el usuario |
|---|---|---|---|
| 01 · Registro como proveedor | `/reto-01/` | `proveedor_*` | `proveedor_simular_envio` |
| 02 · Contratos vigentes | `/reto-02/` | `contratos_*` | `contratos_registrar` (campos en revisión) |
| 03 · Órdenes de compra SAP | `/reto-03/` | `oc_*` | `oc_crear` (confirmaciones pendientes) |

Link de prueba: **[COMPLETAR TRAS DESPLIEGUE]**

## Arranque local (un comando)

```bash
bun install
cp .env.example .env   # pon tu ANTHROPIC_API_KEY
bun run dev            # http://localhost:3000 → /reto-01, /reto-02, /reto-03
```

Cada reto también corre solo: `cd reto-0X && bun install && bun run src/server.ts`.

## Verificación sin modelo

```bash
bun run demo:all       # o: cd reto-0X && bun run demo.ts
```

## Variables de entorno

| Variable | Uso |
|---|---|
| `ANTHROPIC_API_KEY` | Clave del modelo. Solo backend; nunca se expone ni se registra |
| `ANTHROPIC_MODEL` | Por defecto `claude-sonnet-5-5` |
| `FECHA_REFERENCIA` | Fecha "hoy" de las herramientas (2026-09-03 en el despliegue, para reproducir los resultados del PRD) |
| `MAX_ITERATIONS` | Tope de iteraciones herramienta → modelo por turno (25) |
| `MAX_SESSION_TOKENS` | Tope de tokens por sesión (400.000) |
| `MAX_GLOBAL_TOKENS` | Tope de tokens de todo el despliegue (5.000.000) |
| `ACCESS_KEY` | Opcional: si se define, la API exige `x-access-key` o `?key=` |

## API (por reto, bajo `/reto-0X`)

| Método | Ruta | Respuesta |
|---|---|---|
| `POST` | `/api/chat` `{ sessionId, message }` | `{ ok, sessionId, reply, toolCalls[], needsConfirmation, tokensSesion }` |
| `GET` | `/api/sessions/:id` | Historial visible de la sesión |
| `GET` | `/api/health` | `{ ok, provider, model, herramientas }` sin claves |
| `GET` | `/api/out/<ruta>` | Descarga de archivos generados en `out/` |

## Arquitectura común

```
web/index.html ──HTTP──▶ src/http.ts ──▶ src/agent/loop.ts ──▶ src/llm/adapter.ts (interfaz) ──▶ src/llm/anthropic.ts
                                              │
                                              └──▶ src/core/tool.ts (zod, runTool, log) ──▶ src/tools/<reto>.ts ──▶ fixtures/ (lectura) · out/ (escritura)
agent/prompt.md = comportamiento · src/knowledge/*.md = conocimiento · src/tools/ = ejecución
```

- **Confirmación humana forzada en backend:** si el modelo llama una herramienta controlada con `confirmado: true` sin que el usuario haya confirmado en su último mensaje, el ciclo la ejecuta con `confirmado: false`, lo marca como "confirmación bloqueada por el sistema" y deja la acción pendiente. La autorización se usa una sola vez. Prueba: `bun run scripts/test-ciclo.ts`.
- **Valores solo desde herramientas:** las herramientas de escritura recalculan o revalidan en servidor lo que reciben del modelo (mapeo, contrato, payload) y rechazan o corrigen diferencias.
- El núcleo vive en `_core/` y se copia a cada reto con `bun run sync`, para que cada carpeta sea entregable sola.

## Despliegue en Railway

1. Sube este repositorio a GitHub.
2. En Railway: **New Project → Deploy from GitHub repo** → elige el repo (detecta el `Dockerfile`).
3. En **Variables**: `ANTHROPIC_API_KEY` (y opcionalmente `ACCESS_KEY`). `FECHA_REFERENCIA=2026-09-03` ya viene en el Dockerfile.
4. En **Settings → Networking → Generate Domain**. Prueba `https://<dominio>/api/health`.

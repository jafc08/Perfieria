# Reto 01 · Agente "Registro como Proveedor"

Agente conversacional que lee solicitudes de registro como proveedor, cruza los campos con el repositorio maestro, genera el formulario (Excel, PDF o valores para portal) y arma el paquete listo para firma. Nunca firma ni envía sin confirmación.

## Requisitos
- Bun ≥ 1.1 (o Node 20+ para las herramientas).
- `bun install` desde la raíz del repositorio.

## Demo sin modelo (no requiere clave)
```bash
cd reto-01
bun run demo.ts
```
Procesa los 4 casos con fecha de referencia 2026-09-03 y muestra el resultado por caso, el manejo de errores y la confirmación humana. Limpia `out/` al iniciar.

## Levantar la aplicación
```bash
# solo este reto
cd reto-01 && bun run src/server.ts
# o los tres retos en un servicio, desde la raíz
bun run dev        # http://localhost:3000/reto-01/
```

## Variables de entorno (`.env.example`)
| Variable | Uso |
|---|---|
| `ANTHROPIC_API_KEY` | Clave del modelo (solo backend) |
| `ANTHROPIC_MODEL` | Por defecto `claude-sonnet-5-5` |
| `FECHA_REFERENCIA` | Fecha para evaluar vigencias (despliegue: `2026-09-03`) |
| `MAX_ITERATIONS` | Tope de iteraciones por turno (25) |
| `MAX_SESSION_TOKENS` | Tope de tokens por sesión |
| `PORT` | Puerto HTTP |

## API
| Método | Ruta | Cuerpo / respuesta |
|---|---|---|
| POST | `/api/chat` | `{ sessionId, message }` → `{ reply, toolCalls[], needsConfirmation }` |
| GET | `/api/sessions/:id` | Historial de la sesión |
| GET | `/api/health` | `{ ok, provider, model }` |

## Herramientas
`proveedor_leer_solicitud`, `proveedor_mapear_campos`, `proveedor_generar_formulario`, `proveedor_armar_paquete`, `proveedor_simular_envio` (en `src/tools/proveedor.ts`).

## Link de prueba
https://perfieria.onrender.com/reto-01/

## Prompt de ejemplo
```
Procesa el caso "ec-corp-andina". Dime qué campos quedaron llenos, cuáles
faltan, si el paquete está listo para firma y qué soportes debo actualizar.
No envíes nada todavía.
```

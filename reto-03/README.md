# Reto 03 · Agente "Órdenes de Compra SAP"

Agente conversacional que lee el paquete de compra (correo, solicitud, cotización, aprobación y factura), valida los controles RC1–RC10 contra los maestros, construye la OC, genera la evidencia de aprobación y la crea en un SAP simulado con confirmación humana.

## Verificación sin modelo

```bash
bun install
bun run demo.ts
```

No necesita clave. Procesa sol-001…sol-006, muestra la idempotencia (sol-001 dos veces), la confirmación explícita de sol-004 y el rechazo de un payload alterado. Resultado en `out/`.

## Arranque local

```bash
cp ../.env.example .env   # o exporta las variables
bun run src/server.ts     # solo este reto
# o desde la raíz del repositorio, los tres retos en un servidor:
bun run dev               # http://localhost:3000/reto-03/
```

| Variable | Uso |
|---|---|
| `ANTHROPIC_API_KEY` | Clave del modelo (solo en el backend) |
| `ANTHROPIC_MODEL` | Por defecto `claude-sonnet-5-5` |
| `FECHA_REFERENCIA` | Fecha fija de referencia para demos (YYYY-MM-DD) |
| `MAX_ITERATIONS` | Tope de iteraciones herramienta→modelo por turno (25) |
| `MAX_SESSION_TOKENS` | Tope de tokens por sesión |
| `PORT` | Puerto HTTP |

## API

| Método | Ruta | Respuesta |
|---|---|---|
| `POST` | `/api/chat` | `{ sessionId, message }` → `{ reply, toolCalls[], needsConfirmation }` |
| `GET` | `/api/sessions/:id` | Historial completo |
| `GET` | `/api/health` | `{ ok, provider, model }` sin claves |

## Link de prueba

[COMPLETAR TRAS DESPLIEGUE]

## Estructura

```
agent/prompt.md                     comportamiento
src/knowledge/ordenes-compra.md     conocimiento del proceso
src/tools/oc.ts                     herramientas (oc_<export>) · oc-logic.ts · schema.ts
src/sap/adapter.ts · mock.ts        interfaz SapAdapter y SAP simulado
demo.ts                             verificación sin modelo
modulo/                             agente empaquetado (bonus)
SOLUCION.md                         planteamiento de la solución
```

Prompt sugerido para la demo: `Procesa la solicitud "sol-004". Muéstrame la OC como quedaría en SAP, qué validaciones pasó y cuáles no, y no la crees hasta que yo lo confirme.`

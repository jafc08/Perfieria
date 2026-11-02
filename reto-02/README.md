# Reto 02 · Agente "Registro de Contratos Vigentes"

Agente conversacional que actúa como punto único de recepción de contratos: lee el buzón, extrae datos con confianza por campo, clasifica (nuevo / actualización / duplicado / rechazado), alimenta el maestro simulado de SharePoint y genera alertas.

**Link de prueba:** [COMPLETAR TRAS DESPLIEGUE]/reto-02/

## Verificación sin modelo (no requiere clave)
```bash
bun install
bun run demo.ts          # desde reto-02/
```
Procesa msg-001…msg-006 con fecha de referencia 2026-09-03, muestra la segunda pasada con `confirmado: true` para msg-006 y genera `out/alertas.md`. `out/` se limpia al inicio; la salida es idéntica entre ejecuciones (salvo timestamps de los logs).

## Levantar en local
```bash
cp .env.example .env      # completar ANTHROPIC_API_KEY
bun run src/server.ts     # solo este reto
# o, desde la raíz del repositorio, los tres retos en un solo servidor:
bun run dev               # http://localhost:3000/reto-02/
```

## Variables de entorno
| Variable | Uso | Ejemplo |
|---|---|---|
| `ANTHROPIC_API_KEY` | Clave del modelo (solo backend; nunca en front, repo ni logs) | — |
| `ANTHROPIC_MODEL` | Modelo | `claude-sonnet-5-5` |
| `FECHA_REFERENCIA` | Fecha "hoy" para registros y alertas | `2026-09-03` |
| `MAX_ITERATIONS` | Tope herramienta→modelo por turno | `25` |
| `MAX_SESSION_TOKENS` | Tope de tokens por sesión | `200000` |
| `PORT` | Puerto HTTP | `3000` |

## API
| Método | Ruta | Cuerpo / respuesta |
|---|---|---|
| POST | `/api/chat` | `{ sessionId, message }` → `{ reply, toolCalls[], needsConfirmation }` |
| GET | `/api/sessions/:id` | Historial completo de la sesión |
| GET | `/api/health` | `{ ok: true, provider, model }` (sin claves) |

## Estructura
```
agent/prompt.md                     comportamiento (system prompt)
src/knowledge/registro-contratos.md conocimiento del proceso
src/tools/contratos.ts              herramientas zod (contratos_leer_buzon, _extraer, _validar, _registrar, _alertas)
src/contratos/                      extracción, reglas, repositorio de archivos y alertas
src/core/tool.ts                    contrato común de herramientas
fixtures/reto-02/                   insumos (solo lectura)
out/                                generado: sharepoint/, procesados.json, alertas.md, log.jsonl
demo.ts                             verificación sin modelo
modulo/                             agente empaquetado (bonus)
```

## Prompt de ejemplo
> Procesa el buzón de contratos con fecha de hoy 2026-09-03. Registra lo que esté limpio, muéstrame lo que requiere revisión campo por campo y termina con el reporte de alertas. No registres nada dudoso sin preguntarme.

Luego: *"confirmo el valor 0 y la fecha fin 2027-08-31"* → msg-006 queda registrado.

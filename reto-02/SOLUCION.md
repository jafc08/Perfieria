# SOLUCIÓN · Reto 02 — Agente "Registro de Contratos Vigentes"

## 1. Problema en una frase
Periferia no sabe qué contratos tiene vigentes, cuáles vencen ni qué pólizas faltan, porque el maestro está congelado desde el 2026-05-30 y solo llegaban los contratos con póliza. Le duele a la **analista administrativa** (dueña del maestro), a **gerencia** (sin visibilidad de vencimientos) y a la compañía (riesgo de pólizas no constituidas).

## 2. Arquitectura

```
Navegador (web/index.html)                Backend Bun (src/server.ts → src/http.ts)
 ┌───────────────────────┐  POST /api/chat  ┌──────────────────────────────────────────────┐
 │ historial del chat     │ ───────────────▶ │ ciclo del agente (src/agent/loop.ts)          │
 │ llamadas a herramientas│ ◀─────────────── │  · system prompt = agent/prompt.md            │
 │ banda de confirmación  │                  │    + src/knowledge/registro-contratos.md      │
 └───────────────────────┘                  │  · adaptador LLM src/llm/adapter.ts            │
                                            │    → src/llm/anthropic.ts (Messages API)       │
                                            │  · puerta de confirmación (backend)            │
                                            │  · herramientas src/tools/contratos.ts (zod)   │
                                            └───────┬──────────────────────────┬───────────┘
                                                    │                          │
                              fixtures/reto-02 (solo lectura)      out/ (escritura)
                              buzon/, maestro, comerciales          sharepoint/maestro-contratos.csv
                                                                    sharepoint/Contratos/<año>/<cliente>/
                                                                    sharepoint/historial.jsonl
                                                                    procesados.json · alertas.md · log.jsonl
```

| Capa | Dónde vive | Qué contiene |
|---|---|---|
| Comportamiento | `agent/prompt.md` | Rol, reglas que no se rompen, flujo y formato. |
| Conocimiento | `src/knowledge/registro-contratos.md` | Esquema del maestro, RN1–RN7, escala de confianza, decisiones del proceso. |
| Ejecución | `src/tools/contratos.ts` + `src/contratos/*` | Extracción determinista, reglas, archivos. Importable sin servidor (`demo.ts`, `modulo/`). |

Un cambio de regla de negocio toca `src/contratos/reglas.ts` o el conocimiento, nunca el servidor.

## 3. Ciclo del agente
- Bucle: mensaje del usuario → modelo → si pide herramientas, el backend valida los argumentos con zod, ejecuta (`runTool`, nunca lanza), devuelve el resultado → modelo… hasta respuesta final.
- **Tope de iteraciones:** `MAX_ITERATIONS=25` por turno. Al alcanzarlo, el agente responde con lo que tiene y lo que falta. **Tope de tokens por sesión:** `MAX_SESSION_TOKENS`. **Timeout** al proveedor con mensaje claro.
- **Confirmación humana forzada en el backend, no solo en el prompt.** Si el modelo llama `contratos_registrar` con `confirmado: true`, el ciclo lo convierte en `false` salvo que (a) el turno anterior del agente haya dejado una confirmación pendiente y (b) el mensaje actual del usuario sea afirmativo. Así, el modelo no puede autoconfirmarse en la misma vuelta.
- **Defensa en la herramienta:** `contratos_registrar` no confía en el contrato que le pasa el modelo. Vuelve a extraer del adjunto, compara y trata cualquier diferencia como corrección humana que exige `confirmado: true` y queda en `historial.jsonl` (`correccion_humana`).
- Toda llamada queda en el chat (front) y en `out/log.jsonl` (CA4).

## 4. Elección del modelo
- **Anthropic `claude-sonnet-5-5`** vía Messages API con `fetch` (sin SDK, una dependencia menos). Motivo: buen uso de herramientas y seguimiento de instrucciones en español a costo y latencia medios. Cambiar de proveedor solo implica otra implementación de `enviar(mensajes, herramientas)`.
- El modelo **no extrae los datos**: solo orquesta, explica y pide confirmación. Por eso un modelo más pequeño (Haiku) también serviría; se eligió Sonnet para reducir errores de orquestación en lotes de 6+ mensajes.
- **Costo por mensaje procesado** `[ESTIMACIÓN]`: ~4 llamadas a herramientas por mensaje; contexto acumulado ≈ 6–10 k tokens de entrada por iteración (prompt + conocimiento + esquemas ≈ 4 k más resultados), ≈ 0,4 k de salida por iteración.
  `Costo ≈ iteraciones × (tokens_entrada × P_in + tokens_salida × P_out)` ≈ 4 × (8.000 × P_in + 400 × P_out).
  P_in y P_out: `[VERIFICAR EN DOCUMENTACIÓN OFICIAL]` (tarifa vigente del modelo). El caché de prompt reduce la parte fija.

## 5. Estrategia de extracción
| Dato | Cómo se obtiene | Confianza |
|---|---|---|
| Tipo de documento | Primera línea: CONTRATO / OTROSÍ / otro (cotización → rechazado). | — |
| id_contrato | `No. CT-…`/`CM-…`; en otrosí, el contrato que modifica. | 0,95 |
| Partes, NIT, país | Patrón `Entre … , identificada con NIT/RUC/RTN …`; la contraparte es la parte ≠ Periferia. NIT sin DV ni puntos. País por tipo y forma del identificador y por domicilio. Nombre con mayúsculas correctas tomado del bloque de firmas. | 0,95 (0,85 si se infiere) |
| Objeto | Cláusula OBJETO, sin el sujeto "EL CONTRATISTA…", ≤ 200 caracteres. | 0,90 |
| Valor y moneda | Cifra entre paréntesis con código de moneda; el separador de miles se detecta por formato (`265.000.000` vs `120,000.00`). "No tiene valor determinado" → 0 + `valor_indeterminado`. Moneda fuera de la lista → error legible. | 0,95 / 0,6 |
| Fechas | Fechas `(día) de mes de año` de la cláusula PLAZO; plazo en meses → fecha fin derivada; "a partir de la firma" sin día → se propone la fecha del correo. | 0,95 / 0,85 / 0,5 |
| Póliza | Cláusula GARANTÍAS; tipos por palabra clave; si es condicionada → confianza baja; en otrosí, "deberán ampliarse" → póliza pendiente. | 0,95 / 0,5 |

**Dónde entra el modelo:** solo propone (por ejemplo, interpretar lo que confirma el usuario) y explica. **Dónde no entra:** ningún valor registrado sale del modelo; sale de la herramienta o de la confirmación explícita del usuario.

## 6. Regla de gobierno · Manejo corporativo de contratos (propuesta, 1 página)
1. **Canal único.** Todo contrato se envía a `contratos@periferia-ficticia.com`. Lo administra la **analista administrativa** (dueña del maestro), con un **suplente** designado por la gerencia administrativa. El agente lee el buzón; la analista confirma lo dudoso.
2. **Obligación del comercial.** Enviar **todo** contrato firmado (con o sin póliza), **otrosíes** y **actas de terminación o liquidación**, en PDF firmado, dentro de **3 días hábiles** desde la firma. Asunto: `CONTRATO | <cliente> | <id_contrato>` (u `OTROSÍ | …`, `TERMINACIÓN | …`). Cotizaciones y borradores no se envían al buzón.
3. **Acuse automático.** En menos de 1 hora hábil el agente responde al remitente: recibido, clasificación (nuevo / actualización / duplicado / rechazado), id asignado, y lista de datos que quedaron en revisión. Un rechazo explica el motivo y qué reenviar.
4. **Excepciones y escalamiento.** Contrato sin firma, sin valor, sin plazo o con remitente fuera del catálogo: se devuelve al comercial con el faltante; si no se corrige en 5 días hábiles, se escala a la **gerencia comercial**. Pólizas pendientes a 15 días del inicio del contrato se escalan a la gerencia administrativa y al corredor.
5. **Cierre del gap junio–agosto 2026 (una campaña de 2 semanas).**
   - Lista de búsqueda: los **huecos de numeración** del maestro en la serie CT-2026: **CT-2026-001, 003, 005, 008, 010, 013 y 014** (más los que aparezcan entre 016 y el último emitido), y los contratos marco (serie CM).
   - Cruce con **facturación**: todo cliente facturado entre junio y agosto sin contrato en el maestro entra a la lista.
   - Cada comercial recibe su lista y envía los PDF al buzón con asunto `MIGRACION | …`; se registran con `fuente = migracion`.
   - Cierre: lista vacía o justificada (contrato inexistente, anulado o verbal) con visto bueno de la gerencia comercial.
6. **Indicador mensual.** **% de clientes facturados en el mes cuyo contrato existe en el maestro** = clientes facturados con contrato registrado ÷ clientes facturados. Meta `[SUPUESTO]`: ≥ 95 % al tercer mes. Complemento: tiempo mediano entre firma y registro (meta ≤ 3 días hábiles).
   **Dueño del maestro:** la analista administrativa (responde a la pregunta abierta del PRD, porque no hay área legal interna). La revisión jurídica de cláusulas queda fuera del proceso y se contrata cuando se requiera.

## 7. Decisiones y trade-offs
| # | Decisión | Alternativa descartada | Por qué |
|---|---|---|---|
| 1 | Extracción determinista (regex) como fuente única de valores | Extraer con el LLM | Reproducible, auditable y sin costo; el modelo puede "redondear" o inferir. Costo: plantillas muy distintas bajan la confianza y van a revisión. |
| 2 | `registrar` re-extrae y compara con lo que manda el modelo | Confiar en el `contrato` recibido | Evita que el modelo altere valores entre herramientas; toda diferencia es corrección humana trazable. |
| 3 | Confirmación forzada en el backend | Solo instrucción en el prompt | El prompt no garantiza CA3; el backend sí. |
| 4 | Otrosí que ordena ampliar garantías → póliza pendiente | Dejarla vigente | Más alertas, pero no oculta un riesgo real hasta tener la póliza ampliada. |
| 5 | Similitud de objeto por Jaccard de palabras (umbral 0,9) | Embeddings | Sin dependencia externa y explicable; para el mismo cliente con otro servicio da similitud baja (0,05–0,12 en los fixtures). |
| 6 | Sección extra "Vencidos sin cierre" en alertas | Solo lo pedido | El maestro de "vigentes" tiene contratos vencidos (CT-2025-018, CT-2026-002); la dirección debe verlo. |

## 8. Supuestos
- La fecha de referencia se pasa explícita (`hoy`); el despliegue usa `FECHA_REFERENCIA=2026-09-03` para reproducir el escenario del PRD. `fecha_registro` = fecha de referencia.
- Firma sin día (msg-006): se propone la fecha del correo (2026-08-31) como inicio; fin = inicio + 12 meses = 2027-08-31. Va a revisión.
- Contrato por demanda: moneda inferida del país (COP) con confianza baja.
- Los adjuntos ya vienen como texto (`contrato.txt`/`otrosi.txt`); se archivan con extensión `.txt`. El otrosí se archiva como `<id>-otrosi-<mensaje>.txt` y la fila conserva la ruta del contrato original.
- RN7: el core escribe en `out/log.jsonl` la llamada técnica (con `sessionId`) y la herramienta escribe en el mismo archivo el evento de negocio (con `mensaje_id`, `nivel: "negocio"`). Se aceptan dos líneas por llamada para no acoplar el core a este reto.
- Mensajes duplicados y rechazados se marcan en `out/procesados.json` para que no vuelvan a aparecer en el buzón.

## 9. Cobertura
| Historia | Estado | Comentario / qué falta para producción |
|---|---|---|
| HU-1 Leer buzón | Hecho | Conexión real a Exchange/Graph. |
| HU-2 Extraer con confianza | Hecho (texto) | PDF nativo (P1) y OCR de escaneados no implementados. |
| HU-3 Validar y clasificar | Hecho | Calibrar umbral de similitud con más casos reales. |
| HU-4 Registrar y archivar | Hecho | SharePoint real (Graph API) y control de concurrencia en el Excel maestro. |
| HU-5 Alertas | Hecho | Envío programado del reporte a gerencia. |
| HU-6 Errores | Hecho | Errores tipados en todas las herramientas; demo muestra fecha inválida, mensaje inexistente y cotización. |
| `contratos_leer_pdf` (P1) | No hecho | Fuera del tiempo disponible. |
| Módulo reutilizable (bonus) | Hecho | `modulo/` reexporta las mismas herramientas (sin copias). |

`demo.ts` (sin modelo, determinista): msg-001 nuevo con póliza pendiente · msg-002 nuevo no_aplica (USD 120.000) · msg-003 actualización de CT-2026-011 (valor, fecha fin y póliza → pendiente) · msg-004 duplicado · msg-005 rechazado · msg-006 en revisión y luego registrado con confirmación · alertas: CT-2026-009 (27 días) y CT-2026-004 (42 días, póliza pendiente: riesgo principal).

## 10. Uso de IA
- Claude (Anthropic) se usó para analizar el PRD y los fixtures, proponer la arquitectura y escribir el primer borrador del código y la documentación; todo fue revisado y ejecutado con `demo.ts`.
- Descartado de lo propuesto: extraer los datos con el LLM (no determinista) y confiar en el `contrato` que pasa el modelo a `registrar`.
- `[COMPLETAR POR JULIAN: herramientas adicionales usadas, qué ajustó a mano y por qué]`

## 11. Riesgos de producción y mitigación
| Riesgo | Mitigación |
|---|---|
| Plantillas de contrato distintas bajan la extracción | Confianza baja → revisión humana; conjunto de evaluación con contratos reales anonimizados antes de producción; métrica de % de campos corregidos por humanos. |
| PDF escaneados | OCR con revisión obligatoria de valor y fechas. |
| Comerciales no cumplen la regla | Indicador mensual (% facturados en el maestro) y escalamiento a gerencia comercial. |
| Falsos duplicados por variaciones de nombre | Deduplicación por NIT antes que por nombre; avisos de "mismo cliente". |
| El modelo intenta autoconfirmar o alterar valores | Puerta de confirmación en backend + re-extracción en `registrar`. |
| Datos de contratos en un proveedor de IA | El modelo ve los campos extraídos, no el texto completo del contrato; revisar condiciones de retención del proveedor `[VALIDAR CON LEGAL]`. |
| Costo por uso del link público | Topes de iteraciones y tokens por sesión configurables. |

# SOLUCIÓN · Reto 01 — Agente "Registro como Proveedor"

## 1. Problema en una frase
La analista administrativa transcribe a mano, en cada registro de proveedor (8–12 al mes), datos que ya existen en el repositorio maestro, con riesgo de error en datos sensibles (NIT, cuenta bancaria) y dependencia de una sola persona que ya no está.

## 2. Arquitectura

```
web/index.html (chat)            src/http.ts + src/agent/loop.ts            src/tools/proveedor.ts
 historial, tool calls,  ─HTTP─▶  ciclo del agente, sesiones,     ─────▶  leer_solicitud · mapear_campos
 resalte de confirmación ◀──────  puerta de confirmación, topes             generar_formulario · armar_paquete
                                  src/llm/adapter.ts → anthropic.ts         simular_envio
                                                                                │            │
                                                                   fixtures/ (solo lectura)  out/ (escritura)
```

| Capa | Dónde vive |
|---|---|
| Comportamiento | `agent/prompt.md` |
| Conocimiento del proceso | `src/knowledge/registro-proveedor.md` (se concatena al system prompt) |
| Ejecución | `src/tools/proveedor.ts` (importable sin servidor desde `demo.ts` y `modulo/`) |
| Contrato común | `src/core/tool.ts`: `defineTool`, validación zod, `runTool` que nunca lanza, log global |

Un solo servicio en Railway sirve los tres retos en `/reto-01`, `/reto-02` y `/reto-03`; cada reto también arranca solo con `bun run src/server.ts`.

## 3. Ciclo del agente
- Bucle: system prompt (prompt + conocimiento) → modelo → si pide herramientas, el backend valida los argumentos con zod, ejecuta y devuelve el resultado → repite hasta respuesta final.
- **Topes**: `MAX_ITERATIONS=25` por turno (al alcanzarlo responde con lo que tiene y lo que falta) y `MAX_SESSION_TOKENS` por sesión. Timeout al proveedor con mensaje claro.
- **Confirmación humana forzada en el backend**, no solo en el prompt: el ciclo convierte `confirmado: true` en `false` salvo que el turno anterior del agente haya dejado una confirmación pendiente y el mensaje actual de la usuaria sea afirmativo. Así el modelo no puede "autoconfirmarse" en la misma vuelta. El front resalta `needsConfirmation`.
- **Anti-manipulación de valores (CA2)**: `mapear_campos` guarda `out/<caso>/mapeo.json` con sha256. `generar_formulario` ignora cualquier valor que mande el modelo, usa siempre el mapeo del servidor y reporta diferencias en `advertencias`.
- Cada llamada queda en el historial visible y en `out/log.jsonl`; además `out/<caso>/log.jsonl` (RN5). Errores de herramienta o del proveedor se muestran en lenguaje claro y la sesión sigue.

## 4. Elección del modelo
- **Anthropic `claude-sonnet-5-5`** vía Messages API con `fetch` (sin SDK). Razón: buen uso de herramientas, español sólido y latencia razonable para un flujo de 4–5 llamadas. El adaptador `enviar(mensajes, herramientas)` permite cambiar de proveedor sin tocar el ciclo.
- **Costo estimado por caso** `[ESTIMACIÓN]`: 5–6 llamadas al modelo por caso; entrada ≈ 4.000 tokens por llamada (prompt + conocimiento + definiciones de herramientas + historial con resultados) → ≈ 25.000 tokens de entrada; salida ≈ 1.500 tokens.
  `Costo/caso = 25.000 × P_entrada + 1.500 × P_salida` (precios por token) `[VERIFICAR EN DOCUMENTACIÓN OFICIAL]`. Con 12 casos/mes el costo mensual es `12 × Costo/caso`, marginal frente a una hora de analista. Palanca de reducción: caché del system prompt.

## 5. Diseño del portal web (7.4)
- **Estrategia**: navegador controlado (Playwright) en modo asistido, no RPA desatendido. El agente abre el portal en una sesión visible, la persona inicia sesión, y el agente llena campos con los valores de `valores-portal.md`, localizando por etiqueta visible (no por XPath fijo) y deteniéndose si no encuentra una etiqueta.
- **Límites**: CAPTCHA y MFA los resuelve la persona; cambios de layout rompen selectores (mitigación: localizar por etiqueta y modo "solo sugerir" si la confianza baja); cargas de archivos con tamaño o formato restringido.
- **Credenciales**: nunca en el repositorio, el prompt ni los logs. Llegan al representante legal por correo; si se guardan, van en un gestor de secretos (Bitwarden/1Password/Azure Key Vault) y las ingresa la persona. El agente no las ve.
- **División de trabajo**: agente = preparar valores, llenar campos, adjuntar soportes vigentes, captura de pantalla de verificación. Humano = credenciales, CAPTCHA/MFA, revisión final y **clic en "Enviar"**.

## 6. Decisiones y trade-offs
| Decisión | Alternativa descartada | Por qué |
|---|---|---|
| Mapeo exacto por glosario normalizado; similitud solo como sugerencia | Similitud difusa o el modelo decidiendo el mapeo | La similitud mapeaba "Número de contribuyente especial" a "Número de cuenta". Un falso positivo en un dato tributario es peor que un faltante |
| El servidor recalcula el mapeo; el modelo no pasa valores | Aceptar el `mapeo` que propone el modelo | El modelo podría "completar" un campo; el PRD prohíbe valores fuera de herramientas |
| xlsx generado con jszip (OOXML mínimo) | exceljs | Sin dependencias pesadas; además no se recibió el Excel real del cliente |
| PDF nuevo con pdf-lib | Rellenar AcroForm | El PRD acepta PDF generado y no hay PDF original |
| Fecha de referencia como parámetro (`hoy` / `FECHA_REFERENCIA`) | Fecha del sistema fija | Con la fecha real (nov-2026) la Cámara de Comercio ya vence y la demo deja de ser reproducible |
| Confirmación forzada en backend | Solo instrucción en el prompt | Un prompt no es un control |

## 7. Supuestos
- El formulario Excel se genera desde cero con las hojas y celdas de `plantilla-celdas.json` (no se recibió el archivo del cliente).
- Fecha de referencia de la demo y del despliegue: **2026-09-03** (fecha del PRD). En producción, la fecha real.
- Los campos por confirmar se escriben como `[POR CONFIRMAR] valor` y los faltantes como `[FALTANTE]` para que la revisión humana los vea.
- Los montos se escriben con su moneda de origen (COP); no se convierten.
- Todos los datos de Periferia y los clientes son ficticios.
- "Listo para firma" en portal significa "listo para cargar": no hay documento que firmar.

## 8. Cobertura
| Historia | Estado | Falta para producción |
|---|---|---|
| HU-1 Leer la solicitud | Hecho | Leer el correo real (Graph API) y el adjunto binario |
| HU-2 Mapear campos | Hecho | Dueño del maestro y del glosario; ampliar glosario con casos reales |
| HU-3 Excel | Hecho (P0) | Escribir sobre el archivo del cliente conservando su formato |
| HU-3 PDF | Hecho (P1) | Rellenar AcroForm cuando el cliente lo envíe |
| HU-3 Portal | Diseñado + `valores-portal.md` (P2) | Automatización asistida (sección 5) |
| HU-4 Paquete para firma | Hecho | Integración con firma electrónica |
| HU-5 Errores | Hecho | Alertas operativas |
| Simular envío | Hecho (P1) | Envío real con aprobación |

## 9. Uso de IA
- Claude (Anthropic) como asistente de desarrollo para scaffolding, herramientas, pruebas y documentación; revisión humana de cada línea.
- Qué se descartó de lo propuesto y por qué: [COMPLETAR POR JULIAN].

## 10. Riesgos de producción
| Riesgo | Mitigación |
|---|---|
| El modelo inventa un valor plausible | Valores solo desde herramientas; mapeo recalculado en servidor con hash |
| Maestro desactualizado (NIT, cuenta, representante) | Dueño del dato nombrado; fecha de última actualización visible en el checklist |
| Soporte vencido enviado | Vigencia evaluada con fecha real; bloqueo de `listo_para_firma` |
| Exposición de datos bancarios | Solo si la plantilla los pide; nunca en el correo; logs sin valores sensibles completos |
| Plantillas reales peores que los fixtures | Conjunto de evaluación con plantillas reales y medición de faltantes falsos y mapeos erróneos |
| Costo por uso abierto del link | Topes de iteraciones y tokens por sesión; protección por clave si se publica |

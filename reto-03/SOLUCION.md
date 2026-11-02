# SOLUCIÓN · Reto 03 · Agente "Órdenes de Compra SAP"

## 1. Problema en una frase

La analista de compras digita a mano en SAP cada orden de compra y valida de memoria que el aprobador pueda aprobar ese monto en ese centro, mientras muchas OC se crean después de que llega la factura sin que nadie lo mida. Le duele a la analista (tiempo y errores que se corrigen en el cierre), a contabilidad/auditoría (controles no sistemáticos) y a la dirección (no sabe cuántas compras saltan el proceso).

## 2. Arquitectura

```
┌─────────────┐  POST /api/chat   ┌──────────────────────────────────────────┐
│ web/ (chat) │ ────────────────▶ │ src/server.ts → src/http.ts               │
│ - historial │ ◀──────────────── │ src/agent/loop.ts  (ciclo + tope + gate   │
│ - tool calls│  reply, toolCalls,│                     de confirmación)       │
│ - confirmar │  needsConfirmation│ src/llm/adapter.ts → src/llm/anthropic.ts │
└─────────────┘                   └───────┬──────────────────────┬───────────┘
                                          │ runTool (zod)         │
                                ┌─────────▼─────────┐    ┌────────▼─────────┐
                                │ src/tools/oc.ts    │───▶│ src/sap/mock.ts  │
                                │ (+ oc-logic.ts,    │    │ (SapAdapter)     │
                                │  schema.ts)        │    └────────┬─────────┘
                                └─────────┬─────────┘             │
                     fixtures/reto-03/ (solo lectura)      out/ (escritura)
```

| Capa | Dónde vive | Qué contiene |
|---|---|---|
| Comportamiento | `agent/prompt.md` | Rol, reglas, flujo y formato de respuesta |
| Conocimiento | `src/knowledge/ordenes-compra.md` | Matriz RC1–RC10, decisiones de payload, hallazgos de proceso |
| Ejecución | `src/tools/oc.ts` (+ `oc-logic.ts`, `schema.ts`) | Herramientas tipadas con zod; toda la lógica es determinista |
| Integración | `src/sap/adapter.ts`, `src/sap/mock.ts` | Interfaz `SapAdapter` del PRD y mock sobre `out/sap/` |
| Modelo | `src/llm/adapter.ts` | Interfaz `enviar(mensajes, herramientas)`; implementación Anthropic |

Herramientas expuestas al modelo: `oc_leer_paquete`, `oc_validar`, `oc_construir_payload`, `oc_generar_evidencia`, `oc_crear` y una auxiliar `oc_leer_control` (lectura del log de control para auditoría). Un cambio de reglas de negocio toca `oc-logic.ts` y el conocimiento, no el servidor.

Salidas: `out/sap/ordenes.jsonl`, `out/control.csv`, `out/log.jsonl` y por caso `out/<caso>/{validacion,payload,trazabilidad,oc}.json` + `aprobacion.{txt,pdf}`.

## 3. Ciclo del agente

- Bucle clásico: mensajes → modelo → si pide herramientas, el backend valida los argumentos con zod, ejecuta con `runTool` (que nunca lanza) y devuelve el resultado; repite hasta respuesta final o `MAX_ITERATIONS` (25 por defecto). Al llegar al tope responde con lo que tiene y lo que falta.
- `MAX_SESSION_TOKENS` limita el gasto por sesión; timeout al proveedor con mensaje claro. Un error de herramienta o del modelo se muestra en el chat y la sesión sigue.
- **Confirmación humana forzada en el backend, no solo en el prompt.** El ciclo convierte `confirmado: true` en `false` salvo que el turno anterior del agente haya dejado una confirmación pendiente y el último mensaje del usuario sea afirmativo. Así el modelo no puede "autoconfirmarse" en la misma vuelta en que pregunta. El front resalta `needsConfirmation`.
- **Segunda barrera en la herramienta:** `oc_crear` re-valida desde los fixtures, reconstruye el payload en el servidor y rechaza cualquier payload que difiera (comparación de JSON canónico). El modelo no puede alterar montos, proveedor ni centro. Además es idempotente por `solicitud_id`.
- Toda llamada queda en el historial visible del chat y en `out/log.jsonl`.

## 4. Elección del modelo

- **Proveedor y modelo:** Anthropic, `claude-sonnet-5-5`, vía Messages API con `fetch` (sin SDK; menos dependencias y el adaptador queda intercambiable).
- **Por qué:** buen uso de herramientas y seguimiento de instrucciones en español; el trabajo pesado es determinista, así que no se necesita el modelo más caro. Un modelo menor (Haiku) es una alternativa para producción si la evaluación lo permite.
- **Costo por caso** `[ESTIMACIÓN]`: un caso completo usa ~5 llamadas a herramientas en ~6 iteraciones. Con un system prompt + conocimiento de ~2.500 tokens y resultados de herramientas de ~1.500 tokens, el contexto acumulado ronda 25.000–35.000 tokens de entrada y ~1.500 de salida por caso.
  `Costo por caso = tokens_entrada × precio_entrada + tokens_salida × precio_salida`, con precios `[VERIFICAR EN DOCUMENTACIÓN OFICIAL]` en https://docs.claude.com. El caché de prompt sobre el system prompt reduce el costo de entrada en sesiones con varios casos.

## 5. Matriz de controles

| Control | Implementación | Tipo | Caso que lo prueba |
|---|---|---|---|
| RC1 | Busca por NIT normalizado (sin puntos ni DV); sin NIT, por nombre normalizado (sin tildes, puntuación ni "S.A.S."), verificado contra el NIT de la cotización; exige `activo` | Bloqueo | sol-002 (no existe), sol-006 (por nombre) |
| RC2 | `esAprobado()` exige "aprobado" y descarta negaciones ("no aprobado", "rechazado"); el remitente (normalizado, sin tildes) debe estar en los aprobadores del centro | Bloqueo | sol-003 |
| RC3 | Si el aprobador es del centro: valor ≤ su tope. Si no: verifica si algún aprobador del centro alcanza el valor | Bloqueo | sol-003 (tope máx. CC-2020 = 30 M < 74 M) |
| RC4 | Subárea ∈ subáreas del centro | Bloqueo | (ninguno falla; probado en revisión manual) |
| RC5 | `|cot − sol| / sol ≤ 2 %` y misma moneda; detecta montos limitados en la aprobación ("por 25 millones") | Confirmación | sol-004 (6,0 %) |
| RC6 | IVA ausente → `indicador_iva_default` del proveedor | Confirmación + derivado | sol-006 (C1) |
| RC7 | Condiciones ausentes → `condiciones_pago_default` | Derivado | sol-006 (Z030) |
| RC8 | Factura con fecha < fecha de solicitud → `retroactiva = true` | Confirmación | sol-005 |
| RC9 | Fecha de aprobación ≥ fecha de solicitud | Confirmación | (ninguno falla) |
| RC10 | `|cantidad × unitario − total| ≤ 1` | Bloqueo | (ninguno falla) |

Controles adicionales (observaciones, no bloquean): segregación de funciones (sol-005), cotización vencida, maestros de IVA y pago inexistentes (bloqueo).

**El más difícil: RC2 + RC3 cruzados (sol-003).** La regla literal solo dice "aprobador del centro" y "tope del aprobador para ese centro". Pero si el aprobador no pertenece al centro, RC3 no tiene contra qué compararse. Resolví evaluar RC3 contra todos los aprobadores del centro: así se descubre que en CC-2020 **nadie** puede aprobar 74 M (tope máximo 30 M). Es un hueco de la matriz de topes, no solo un error del solicitante. Además, el texto de la aprobación dice "para el equipo de preventa": el agente sugiere verificar si el centro correcto es CC-3030/Preventa (fvargas, tope 80 M), sin cambiarlo por su cuenta.

Resultados de `demo.ts`:

| Caso | Resultado |
|---|---|
| sol-001 | OC 4500000001 (y 4500000001 de nuevo: idempotente) |
| sol-002 | Bloqueada RC1: proveedor inexistente → solicitar alta |
| sol-003 | Bloqueada RC2 + RC3; observación preventa/CC-3030 |
| sol-004 | Pendiente RC5 → OC 4500000002 tras `confirmado = true` |
| sol-005 | Pendiente RC8, `retroactiva = true`; observación de segregación |
| sol-006 | Pendiente RC6 (IVA C1 derivado), Z030 derivado |

## 6. Diseño del adaptador SAP real

Los nombres de servicios y campos de esta sección se marcan `[VERIFICAR EN DOCUMENTACIÓN OFICIAL SAP]`.

**Opción elegida:** si Periferia usa S/4HANA, la API OData `API_PURCHASEORDER_PROCESS_SRV` (o su sucesora) expuesta mediante un servicio de integración (SAP Integration Suite o un microservicio propio). Si es ECC, RFC a `BAPI_PO_CREATE1` (+ `BAPI_TRANSACTION_COMMIT`) desde ese mismo servicio. Razón: con viabilidad no confirmada, la interfaz `SapAdapter` aísla la decisión; el agente no cambia, solo se cambia `mock.ts` por `odata.ts` o `rfc.ts`. El servicio de integración centraliza credenciales, reintentos y auditoría.

**Mapeo payload → OData:**

| Payload (7.4) | Campo SAP |
|---|---|
| tipo fijo | `PurchaseOrderType` (p. ej. NB) |
| `sociedad` | `CompanyCode` |
| `organizacion_compras` | `PurchasingOrganization` (+ `PurchasingGroup` por configuración) |
| `proveedor.codigo_sap` | `Supplier` |
| `moneda` | `DocumentCurrency` |
| `condiciones_pago` | `PaymentTerms` |
| `referencia.solicitud_id` | Campo de referencia externa de cabecera (p. ej. `CorrespncExternalReference`) |
| `posiciones[].numero` | `PurchaseOrderItem` (10, 20…) |
| `posiciones[].descripcion` | `PurchaseOrderItemText` (sin material) o `Material` si existe |
| `posiciones[].cantidad` / `unidad` | `OrderQuantity` / `PurchaseOrderQuantityUnit` |
| `posiciones[].precio_unitario` | `NetPriceAmount` (precio neto, por eso se envía la base sin IVA) |
| `posiciones[].indicador_iva` | `TaxCode` |
| `centro_costo` | `AccountAssignmentCategory = K` + `CostCenter` en la imputación de la posición |
| `subarea` | Campo de imputación adicional o texto, según configuración `[VALIDAR CON CONTABILIDAD]` |
| `aprobador` + evidencia | Anexo (GOS/Attachment Service) con el PDF y su sha256 en una nota de cabecera |

**Autenticación:** usuario técnico de comunicación con OAuth 2.0 client credentials o certificado X.509, con permisos mínimos (crear y leer OC). Las credenciales viven en un gestor de secretos (Azure Key Vault, AWS Secrets Manager o el de la Integration Suite), nunca en el agente, el prompt, el repositorio ni los logs.

**Idempotencia y errores:**
1. Antes de crear: `buscarOrdenPorReferencia(solicitud_id)` consulta OC por la referencia externa; si existe, devuelve su número.
2. Cada envío lleva una clave de idempotencia = `solicitud_id`; el servicio de integración la guarda con el estado (enviado, creado, error).
3. Timeout o error de red: no se reintenta a ciegas; primero se consulta por referencia y solo se reintenta si no existe.
4. Error parcial (cabecera creada, posición rechazada): BAPI permite no hacer commit; en OData se envía en un solo deep insert. Si SAP devuelve mensajes, se registran en `control.csv` como `error_sap` con el mensaje y la OC queda para revisión humana; nunca se deja una OC a medias sin reportar.

**Plan B (si la conexión no es viable):** el agente sigue haciendo lo que más tiempo ahorra (leer, validar, derivar y armar la evidencia) y produce: (a) un archivo de carga masiva (CSV/LSMW o plantilla de Migration Cockpit) con las OC validadas del día, o (b) una ficha "lista para pegar" en ME21N, campo por campo, con la evidencia PDF lista para adjuntar. La analista solo copia y adjunta; los controles RC1–RC10 ya se cumplieron.

## 7. Lectura del proceso: OC retroactivas

**Qué le diría a la dirección:** una OC creada después de la factura no controla nada. Solo formaliza un gasto que ya ocurrió. Se pierden tres controles: comparar cotizaciones antes de comprometer, verificar que el aprobador tenga autoridad antes del gasto y conocer el compromiso presupuestal a tiempo. En sol-005 la aprobación dice literalmente "Ya llegó la factura, por favor crear la OC para poder radicarla": la aprobación llegó 18 días después de la factura.

**Cómo medirlo:** el agente marca `retroactiva = true` en `out/control.csv` en cada intento. El indicador mensual es % de OC retroactivas = OC con factura anterior a la solicitud ÷ OC creadas, por centro de costo y por proveedor. Con 4–8 semanas de datos se sabe si es un problema de pocos centros o de toda la compañía.

**Cambio de proceso que propondría** (la decisión de tolerar o rechazar es de la dirección):
1. Política "sin OC no hay pago": cuentas por pagar no radica facturas sin OC previa.
2. Excepción formal para compras urgentes o recurrentes de bajo monto (umbral a definir), con aprobación explícita de la excepción y registro.
3. Acuerdos marco u OC abiertas para gastos recurrentes (papelería, licencias) para que no dependan de una OC por factura.
4. Revisión mensual del indicador con los dueños de los centros con más retroactivas.

**Segundo hallazgo: segregación de funciones.** En sol-005 la solicitante es Camila Ortiz y el correo va dirigido a "Hola Camila" en compras: la misma persona solicita y crea la OC. El agente lo reporta como observación. Recomiendo que otra persona cree o revise las OC donde solicitante y analista coinciden.

**Tercer hallazgo: la matriz de topes tiene huecos.** En CC-2020 el tope máximo es 30 M; una compra de 74 M no tiene aprobador posible dentro del centro.

## 8. Decisiones y trade-offs

| # | Decisión | Alternativa descartada | Por qué |
|---|---|---|---|
| 1 | Precio unitario **base sin IVA** (unitario ÷ 1,19) | Enviar el precio con IVA incluido | Las cotizaciones vienen IVA incluido y SAP suma el impuesto según `TaxCode`: enviar el bruto inflaría la OC 19 %. Riesgo: redondeo de centavos; el bruto queda en la trazabilidad. `[VALIDAR CON CONTABILIDAD]` |
| 2 | Valor de la OC = **valor aprobado** (solicitud) y la diferencia con la cotización como confirmación | Usar el valor cotizado | En sol-004 la aprobación dice "por 25 millones": crear por 26,5 M crearía una OC no autorizada. Se recomienda re-aprobación si se quiere el valor cotizado |
| 3 | `oc_crear` **reconstruye y compara** el payload | Confiar en el payload que envía el modelo | Cumple CA2 por diseño: el modelo no puede "arreglar" un monto. Costo: el modelo debe reenviar el payload sin cambios |
| 4 | Confirmación forzada en el backend | Confiar en que el prompt haga preguntar | Un prompt se puede saltar; el backend no |
| 5 | Validación 100 % determinista; el modelo solo orquesta y explica | Extraer la cotización con el modelo | Los controles son reglas exactas: un modelo no debe decidir un tope. La cotización se lee con expresiones regulares sobre un formato estable |
| 6 | RC3 evaluado contra todos los aprobadores del centro | Aplicar RC3 solo si RC2 pasa | Revela huecos de la matriz de topes (sol-003) |

## 9. Supuestos

- Las cotizaciones y solicitudes expresan precios con IVA incluido (así lo dicen los fixtures).
- `sociedad` y `organizacion_compras` son "1000" (dado por el PRD).
- La unidad se infiere de la descripción (`H` si habla de horas, `UN` por defecto).
- Los `correo.json` de sol-003 y sol-004 no estaban en el material recibido; se recrearon con el mismo patrón que los demás (id, remitente = solicitante, fecha = fecha de solicitud a las 09:00). No afectan ningún control.
- "Aprobado por X" en el cuerpo de la aprobación se interpreta como el monto autorizado.
- El saludo "Hola <nombre>" del correo identifica a la persona de compras que crea la OC (heurística para la observación de segregación).
- La fecha de la OC en el mock es la fecha real de ejecución.

## 10. Cobertura

| Historia | Estado | Qué falta para producción |
|---|---|---|
| HU-1 Leer el paquete | Hecho | Leer `.xlsx`, PDF y `.eml` reales (P1 `oc_leer_excel` no implementado) |
| HU-2 Validar | Hecho (RC1–RC10 + observaciones) | Maestros en línea desde SAP en lugar de JSON |
| HU-3 Payload | Hecho (zod + trazabilidad) | Validar el mapeo de subárea con contabilidad |
| HU-4 Evidencia | Hecho (txt P0 + pdf P1) | Adjuntar el `.eml` original firmado si auditoría lo exige |
| HU-5 Crear | Hecho (idempotente, control.csv) | Adaptador real (sección 6) |
| HU-6 Errores | Hecho (`{ ok:false, error }` con qué pedir) | Casos de prueba con paquetes corruptos adicionales |
| Bonus módulo | Hecho (`modulo/` reexporta las mismas herramientas) | — |

## 11. Uso de IA

- **Asistente usado:** Claude (Anthropic) como copiloto de desarrollo: análisis del PRD y de los fixtures (incluida la detección de casos borde), propuesta de arquitectura, primer borrador del código, de `demo.ts` y de la documentación. Cada línea fue revisada, ejecutada con `demo.ts` y probada en el despliegue.
- **Descartado de lo propuesto y por qué:**
  - Confiar solo en el prompt para la confirmación humana: se reemplazó por una compuerta en el backend, porque el modelo podía pasar `confirmado: true` sin que el usuario confirmara.
  - Dejar que el modelo pase valores entre herramientas sin control: las herramientas de escritura recalculan o revalidan en el servidor lo que reciben.
  - Dependencias pesadas (SDK del proveedor LLM, librería de Excel): se usó `fetch` directo y OOXML con `jszip`, para reducir dependencias y mantener el adaptador LLM intercambiable.
  - Plataformas de despliegue sin disco escribible o con funciones serverless (Cloudflare Workers, Vercel): la app escribe en `out/`; se desplegó como contenedor Docker en Render.
  - Dejar que el modelo calcule el precio base o decida el valor de la OC: lo hace la herramienta y queda en la trazabilidad.

## 12. Riesgos de llevar esto a producción

| Riesgo | Mitigación |
|---|---|
| Integración SAP no viable a corto plazo | Plan B: carga masiva o ficha para ME21N; la interfaz `SapAdapter` permite cambiar sin tocar el agente |
| Formatos de cotización distintos al fixture | Extractor determinista con pruebas por proveedor; si no se lee el total, el caso pasa a confirmación, nunca se adivina |
| Precio base vs bruto mal acordado con contabilidad | Validar la convención antes del piloto; trazabilidad conserva ambos valores |
| Maestros desactualizados (proveedores, topes) | Consultar SAP en línea; dueño del dato por maestro |
| Aprobación por correo falsificable | Verificar encabezados DKIM/SPF del `.eml` o migrar a aprobación en flujo con firma |
| Inyección de instrucciones en correos o cotizaciones | Contenido tratado como dato; decisiones en código, no en el modelo |
| Costo del modelo en un link público | Tope de iteraciones y de tokens por sesión; clave solo en el backend |
| Sesgo de automatización (confirmar sin leer) | La confirmación muestra los dos valores en conflicto y la recomendación; medir el tiempo entre pregunta y confirmación |

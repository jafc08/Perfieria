---
name: ordenes-compra
description: Conocimiento del proceso de órdenes de compra de Periferia: controles RC1–RC10, construcción del payload SAP, evidencia de aprobación y OC retroactivas.
---

# Conocimiento del proceso · Órdenes de compra SAP

## Paquete de entrada
Correo del solicitante + solicitud (Excel normalizado a JSON) + cotización del proveedor + correo de aprobación del líder + factura (solo cuando ya llegó). Un adjunto ausente se informa; no se inventa.

## Matriz de controles

| Código | Regla | Tipo | Acción si falla |
|---|---|---|---|
| RC1 | Proveedor existe en el maestro (por NIT; sin NIT, por nombre normalizado verificado contra el NIT de la cotización) y está activo | Bloqueo | Pedir alta o reactivación del proveedor |
| RC2 | La aprobación existe, dice "Aprobado" (sin negación) y viene de un aprobador del centro de costo | Bloqueo | Pedir aprobación a un aprobador del centro |
| RC3 | Valor total ≤ tope del aprobador en ese centro; si el aprobador no es del centro, se verifica que algún aprobador del centro tenga tope suficiente | Bloqueo | Escalar o revisar la matriz de topes |
| RC4 | La subárea pertenece al centro de costo | Bloqueo | Pedir la subárea correcta |
| RC5 | Cotización vs solicitud: desviación ≤ 2 % (y misma moneda); sin cotización → confirmación | Confirmación | Mostrar ambos valores; si la aprobación limita un monto, advertir que el valor cotizado requiere re-aprobación |
| RC6 | Indicador de IVA ausente → se deriva del proveedor | Confirmación + derivado | Confirmar el indicador propuesto |
| RC7 | Condiciones de pago ausentes → se derivan del proveedor | Derivado (informativo) | Informar |
| RC8 | Factura con fecha anterior a la solicitud → OC retroactiva | Confirmación | Confirmar; queda marcada `retroactiva = true` en `out/control.csv` |
| RC9 | Fecha de aprobación ≥ fecha de solicitud | Confirmación | Confirmar |
| RC10 | cantidad × valor unitario = valor total (± 1) | Bloqueo | Pedir corrección del Excel |

## Decisiones de construcción del payload
- **Precio unitario base sin IVA.** Las cotizaciones vienen con IVA incluido; SAP calcula el IVA a partir del indicador. Precio base = valor unitario ÷ (1 + tasa), redondeado a 2 decimales. El bruto queda en la trazabilidad.
- **Valor de la OC = valor de la solicitud** (lo aprobado), aun cuando la cotización difiera; la diferencia se expone como confirmación.
- **Descripción** máximo 40 caracteres (texto breve de SAP): se recorta y el texto completo queda en la excepción `TEXTO_TRUNCADO`.
- **Unidad**: `H` si la descripción habla de horas; `UN` por defecto.
- **Trazabilidad**: cada valor con fuente `solicitud`, `cotizacion`, `aprobacion`, `maestro.<nombre>` o `derivado` en `out/<caso>/trazabilidad.json`.
- **Evidencia**: `out/<caso>/aprobacion.txt` y `.pdf` con sha256; el hash viaja en el payload.

## Creación
- Solo si `apta` y (sin confirmaciones o `confirmado = true` tras confirmación explícita del usuario).
- Idempotente por `solicitud_id`: si ya existe, se devuelve el mismo número.
- El servidor reconstruye el payload y rechaza cualquier payload alterado.
- Cada intento queda en `out/control.csv` (creada, bloqueada, pendiente, idempotente, rechazada).

## Hallazgos de proceso a reportar
- **OC retroactivas**: la OC deja de ser un control previo y se vuelve un trámite para radicar la factura. Se miden con `control.csv`.
- **Segregación de funciones**: si quien solicita es la misma persona que crea la OC, se reporta como observación de control.
- **Matriz de topes**: si ningún aprobador de un centro alcanza el valor, la matriz tiene un hueco que debe decidir la dirección.

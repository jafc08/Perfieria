# Conocimiento del proceso · Registro como proveedor

## Qué es
Los clientes de Periferia (Colombia, Ecuador, Perú, Panamá, Honduras) piden entre 8 y 12 registros de proveedor al mes. Cada solicitud llega por correo con una plantilla (Excel, PDF o portal web) y una lista de soportes. Los datos ya existen en el repositorio maestro (`fixtures/reto-01/repositorio/maestro.json`) y los soportes en `repositorio/soportes/` con su índice de vigencias.

## Estados de un campo
| Estado | Significado | ¿Bloquea la firma? |
|---|---|---|
| `lleno` | Tiene fuente en el maestro (ruta indicada) | No |
| `faltante` | No existe en el maestro. Nunca se inventa | No, pero aparece en el checklist |
| `requiere_confirmacion` | Mapeo con confianza < 0.8 o regla de país | No, pero la analista debe confirmarlo antes de firmar |

## Identificador tributario por país (RN1)
| País | Identificador |
|---|---|
| CO | NIT |
| EC | RUC |
| PE | RUC |
| PA | RUC |
| HN | RTN |

Periferia solo tiene NIT colombiano. En países distintos de CO, el campo se llena con el NIT y se marca `requiere_confirmacion` con la nota "identificador extranjero". La etiqueta "Identificación tributaria" es ambigua y siempre se confirma.

## Reglas de negocio
- **RN1** Identificador tributario según la tabla anterior.
- **RN2** Datos bancarios solo si la plantilla los pide explícitamente. Nunca en `borrador-correo.md`.
- **RN3** Un soporte vencido (`vigencia_hasta` anterior a la fecha de referencia) o un soporte exigido ausente bloquea `listo_para_firma`. Un campo faltante no lo bloquea.
- **RN4** Ninguna acción externa (envío, firma, carga a portal) sin confirmación explícita de la usuaria en el turno inmediatamente anterior.
- **RN5** Toda ejecución deja registro en `out/<caso>/log.jsonl` y en `out/log.jsonl`.
- Montos con moneda (por ejemplo, ingresos anuales) se escriben con su moneda de origen; nunca se convierten.

## Mapeo de etiquetas
1. Coincidencia exacta con el glosario tras normalizar (minúsculas, sin tildes) → confianza 1.0.
2. Si no hay coincidencia, similitud de palabras solo como sugerencia: ≥ 0.8 lleno; 0.5–0.8 requiere confirmación; < 0.5 faltante.
3. Si la clave no tiene valor en el maestro → faltante.

## Formatos de salida
| Formato | Salida | Estado |
|---|---|---|
| xlsx | `out/<caso>/formulario.xlsx` en la hoja y celda de la plantilla | Soportado (P0) |
| pdf | `out/<caso>/formulario.pdf` con etiqueta y valor en orden | Soportado (P1) |
| portal | `out/<caso>/valores-portal.md` | No soportado: lo opera una persona |

## Qué hace el humano
- Confirmar campos marcados y completar faltantes.
- Actualizar soportes vencidos o ausentes (por ejemplo, Cámara de Comercio de 30 días, parafiscales mensuales).
- Firmar (representante legal) y autorizar el envío.
- En portales: ingresar credenciales, pegar valores, cargar soportes y hacer clic en "Enviar".

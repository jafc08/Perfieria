# Conocimiento del proceso · Registro de contratos vigentes

## Contexto
El maestro de contratos estuvo congelado desde el 2026-05-30. Antes solo llegaban a administración los contratos con póliza. Desde ahora todo contrato, otrosí o acta de terminación entra por el buzón único `contratos@periferia-ficticia.com`.

## Esquema del maestro (una fila por contrato)
| Columna | Regla |
|---|---|
| id_contrato | Número del documento (CT-…, CM-…). Si no existe: AUTO-<año>-<secuencia>. |
| cliente | Razón social de la contraparte (no Periferia). |
| nit_cliente | Identificador tributario sin dígito de verificación ni puntos. |
| pais | CO (NIT), EC (RUC de 13 dígitos terminado en 001), PE (RUC de 11 dígitos), HN (RTN), PA (por domicilio). |
| objeto | Máx. 200 caracteres. |
| valor | Número sin separadores. 0 si es por demanda (valor indeterminado). |
| moneda | COP, USD, PEN, PAB, HNL. Otra moneda es un error. |
| fecha_inicio / fecha_fin | YYYY-MM-DD. fecha_fin puede derivarse de un plazo en meses. |
| requiere_poliza / tipo_poliza | Sección de garantías. Tipos separados por `;` (cumplimiento, responsabilidad_civil, calidad, salarios_prestaciones). |
| estado_poliza | vigente, pendiente, vencida, no_aplica. Nuevo con póliza → pendiente. |
| comercial | Nombre resuelto desde el catálogo de comerciales. Remitente desconocido → se reporta, no bloquea. |
| ruta_sharepoint | Contratos/<año_inicio>/<cliente-slug>/<id_contrato>.<ext> |
| fecha_registro / fuente | Fecha de referencia del registro; fuente = buzon. |

## Reglas de negocio
- **RN1 Duplicado:** mismo id_contrato y mismos valor, fecha_inicio y fecha_fin. No se escribe.
- **RN2 Actualización:** mismo id_contrato (o mismo NIT + objeto con similitud ≥ 0,9) con algún campo distinto, o el documento es un otrosí. Se actualiza la fila y se registra en historial.jsonl.
- **RN3 Nuevo:** sin coincidencia. Se inserta.
- **RN4 Rechazado:** sin adjunto de contrato, o texto sin partes ni objeto identificables.
- **RN5 Confianza:** campos con confianza < 0,8 → requiere_revision. Registrar sin confirmado=true se rechaza.
- **RN6:** el fixture del maestro es de solo lectura; la primera ejecución lo copia a out/sharepoint/.
- **RN7:** toda herramienta deja un evento en out/log.jsonl con { ts, herramienta, mensaje_id, ok, resumen }.

## Cómo se calcula la confianza
- 0,95: valor leído literalmente con un patrón inequívoco (número de contrato, NIT, cifra entre paréntesis con moneda, fechas con día/mes/año).
- 0,85–0,90: valor leído pero con una transformación (objeto truncado, nombre convertido desde mayúsculas, país solo por identificador, fecha fin = inicio + meses).
- 0,5–0,7: valor derivado de un supuesto (firma sin día, contrato por demanda, póliza condicionada, moneda inferida del país). Siempre va a revisión humana.
- 0: campo ausente en el texto. Nunca se inventa.

## Decisiones del proceso
- **Otrosí:** solo actualiza los campos que modifica; los demás se conservan del maestro. Si ordena ampliar las garantías, `estado_poliza` pasa de vigente a **pendiente** hasta que se reciba la póliza ampliada.
- **Mismo cliente, distinto objeto:** se registra como contrato nuevo y se reporta la coincidencia de NIT como aviso.
- **Contrato marco por demanda:** valor 0, fechas desde la firma; si la firma no trae día, se propone la fecha del correo y se pide confirmación.
- **Póliza condicionada** (por ejemplo, solo para órdenes que superen un monto): se propone requiere_poliza = true con confianza baja y se pide confirmación.

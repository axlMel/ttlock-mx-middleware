# Plan 007 — Command gateway y auditoría

## Decisiones
1. **Un intento, sin ciclos.** Toda política de reintento es de `specs/002`; el gateway es una función de “enviar una vez y clasificar”. Así la regla “nunca retransmitir a ciegas” vive en un solo lugar.
2. **Clasificar en una función pura** (`classify.ts`) que recibe estado HTTP y cuerpo ya leído; el gateway solo hace la llamada y la pasa. Se prueba sin red.
3. **Auditoría como dependencia** (`CommandAuditLog`): el gateway no sabe de archivos. `createAuditLog` escribe JSONL; las pruebas del gateway usan una auditoría falsa.
4. **INTENT con `fsync`.** Es la garantía de que ningún comando físico sale sin rastro; el costo (un `fsync` por envío) es despreciable al ritmo de esta operación.
5. **Escrituras serializadas** con una cadena de promesas dentro del proceso, para que dos envíos no mezclen líneas.
6. **Sin redirecciones y solo HTTPS.** Protege la API key.
7. **La API key nunca se interpola en texto.** Se pasa solo en el encabezado; los errores se construyen con mensajes propios, no con el error original de `fetch` si pudiera contener la petición.
8. **`InvalidCommandInputError` se importa de `src/protocol`** (su entrada pública) para no duplicar la clase.
9. **Opciones por parámetro**, sin `process.env` (lo lee 006).

## Estructura
```
src/gateway/
  types.ts
  errors.ts            AuditUnavailableError
  classify.ts          clasificación pura
  auditLog.ts          createAuditLog (JSONL diario, fsync del INTENT)
  commandGateway.ts
  index.ts             única entrada pública
  commandGateway.test.ts
```

## Orden de trabajo
Tipos y errores → clasificación (con tabla de pruebas) → auditoría de archivo → gateway (validación, INTENT, llamada, RESULT, modo sombra) → pruebas de la API key y de redirecciones.

## Riesgos
- `OUTCOME_UNKNOWN` y `SENT_UNCONFIRMED` no prueban entrega: lo resuelve 002 con el ACK en las tramas.
- Un disco lleno impide auditar y, por diseño, impide enviar: el orquestador debe alertar y reintentar más tarde (spec 002).
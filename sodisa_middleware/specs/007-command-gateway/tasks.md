# Tasks 007 — Command gateway y auditoría

- [x] **T1. Tipos y errores.** `types.ts`, `errors.ts` (`AuditUnavailableError`); reutilizar `InvalidCommandInputError` de `src/protocol`.
- [x] **T2. Clasificación.** `classify.ts` con una prueba por fila de la tabla (200 válido, 200 ilegible, 200 sin `status`, 503, 401/403/404/409/422, otro 4xx, 3xx, 5xx, `OUTCOME_UNKNOWN`).
- [x] **T3. Auditoría de archivo.** `createAuditLog`: JSONL por día UTC, creación del directorio, `fsync`, serialización. Pruebas con directorio temporal y reloj inyectado.
- [x] **T4. Gateway.** Validación ASCII y de `https://`, `INTENT`, llamada con `fetch` falso (URL, encabezados, cuerpo, `redirect: 'manual'`), timeout, error de red, `RESULT`.
- [x] **T5. Modo sombra.** Sin `fetch`; `INTENT` y `RESULT` con `dryRun: true`.
- [x] **T6. Fallos de auditoría.** `INTENT` falla → sin `fetch` y `AuditUnavailableError`; `RESULT` falla → resultado devuelto.
- [x] **T7. API key.** Prueba con la clave como valor reconocible: no aparece en archivo, errores ni logs.
- [x] **T8. Entrada pública.** `index.ts` exporta solo lo de la spec.
- [x] **T9. Cierre.** `npm run lint`, `npm run build` y `npm test` completos en verde. Fila de 007 en `AGENTS.md` actualizada (solo esa; si la fila no existe, listarlo en el resumen sin editar el resto). Commit.

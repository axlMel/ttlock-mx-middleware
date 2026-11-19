# Tasks 001 — Detectores

- [x] **T1. `SqlClient` compartido.** Crear `src/db/types.ts`; `src/catalog/` lo importa de allí. `npm test` sigue en verde.
- [x] **T2. Tipos.** `src/detectors/types.ts` con las interfaces de la spec.
- [x] **T3. Asignaciones.** `createAssignmentDetector` con A1 y A2, validación de ids y fixtures de filas. Pruebas: tipado, `$2`, zona distinta de UTC, no vigente, `null`, id inválido.
- [x] **T4. Microsegundos.** `micros.ts` con prueba (0 a 6 decimales, diferencia de 1 µs).
- [x] **T5. Particiones.** `partitions.ts`: P0, caché por `partitionRefreshMs`, validación del nombre, alerta `PARTITION_DISAPPEARED`.
- [x] **T6. `initCursor`.** C0 y C0b, sin tramas, partición más nueva sin permiso.
- [x] **T7. `readNew`.** C1 y C1b, deduplicación, `recentIds`, `hasMore`, `CHAIN_WINDOW_SATURATED`.
- [x] **T8. Cambio de partición.** Agotada la actual, paso a la nueva; `42501` → seguir con una sola alerta.
- [x] **T9. Sin JOIN ni `SELECT *`.** Prueba sobre las cadenas SQL de `src/detectors/`.
- [x] **T10. Entrada pública.** `index.ts` exporta solo lo de la spec.
- [x] **T11. Cierre.** `npm run lint`, `npm run build` y `npm test` completos en verde. Fila de 001 en `AGENTS.md` actualizada (solo esa). Commit.
- [x] **T12. Enmienda de estados.** A1 filtra 3 y 4 con `bol_enuso`; exportar `VIGENT_STATES` e `isActiveAssignment` por `index.ts`; actualizar fixture y probar la regla, el texto SQL y su concordancia con la constante.

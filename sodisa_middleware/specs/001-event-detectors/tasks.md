# Tasks 001 — Detectores

- [x] **T1. `SqlClient` compartido.** Crear `src/db/types.ts`; `src/catalog/` lo importa de allí. `npm test` sigue en verde.
- [x] **T2. Tipos.** `src/detectors/types.ts` con las interfaces de la spec.
- [x] **T3. Asignaciones.** `createAssignmentDetector` con A1 y A2, validación de ids y fixtures de filas. Pruebas: tipado, `$2`, zona distinta de UTC, no vigente, `null`, id inválido.
- [x] **T4. Microsegundos.** `micros.ts` con prueba (0 a 6 decimales, diferencia de 1 µs).
- [x] **T5. Particiones.** `partitions.ts`: P0, caché, validación del nombre y alertas (implementación original; sustituida por T14).
- [x] **T6. `initCursor`.** C0 y C0b, sin tramas y respaldo por permiso (implementación original; sustituida por T15).
- [x] **T7. `readNew`.** C1 y C1b, deduplicación, `recentIds`, `hasMore`, `CHAIN_WINDOW_SATURATED`.
- [x] **T8. Cambio de partición.** Implementación original, sustituida por T16.
- [x] **T9. Sin JOIN ni `SELECT *`.** Prueba sobre las cadenas SQL de `src/detectors/`.
- [x] **T10. Entrada pública.** `index.ts` exporta solo lo de la spec.
- [x] **T11. Cierre.** `npm run lint`, `npm run build` y `npm test` completos en verde. Fila de 001 en `AGENTS.md` actualizada (solo esa). Commit.
- [x] **T12. Enmienda de estados.** A1 filtra 3 y 4 con `bol_enuso`; exportar `VIGENT_STATES` e `isActiveAssignment` por `index.ts`; actualizar fixture y probar la regla, el texto SQL y su concordancia con la constante.
- [x] **T13. Hora final nula.** Tipar `horaFinal` como `Date | null`, preservar `NULL` de A1/A2 y probar una fila nula y otra con fecha.
- [x] **T14. Calendario y catálogo.** Probar `weekLabel`, `weekStartMs` y `previousLabel` con fixtures y propiedades 2025–2035; P0 completo y bajo demanda, singleflight, respaldo y alertas.
- [x] **T15. Inicio de cursor.** Elegir etiqueta calculada, C0/C0b, respaldo por `42501`, equipo apagado y ausencia de `previous` incluso dentro de la ventana doble.
- [x] **T16. Lectura semanal.** Marcas independientes, orden y deduplicación entre particiones, lotes llenos, ventana doble, cambios de año, `42501`, callback y SQL sin JOIN ni `SELECT *`.

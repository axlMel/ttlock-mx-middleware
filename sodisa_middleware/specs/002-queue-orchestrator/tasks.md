# Tasks 002 — Orquestador

- [x] **T1. Tipos y serial.** `types.ts` (interfaces de la spec, eventos, efectos, `StepTask`) y `serial.ts` con prueba (0 → `0000`, 255 → `00FF`, mayúsculas).
- [x] **T2. Transiciones puras.** `transition.ts`: filas 3 a 11 y avance de paso (siguiente punto no cumplido, paso de reset, `closing`). Una prueba por fila y por rama (incluidas: ACK de otro serial, duplicado, salida sin entrada, `geofenceId` distinto de 0, plan con puntos agregados o eliminados).
- [x] **T3. Scheduler y exclusión.** Interfaz y `FakeScheduler` con tiempo controlado; `keyedMutex.ts` con prueba de no solapamiento por `assignmentId`.
- [x] **T4. Transmisión.** `stepRunner.ts`: `pendingRequest` antes de llamar, clave `{assignmentId}-{stepSeq}-{transmissionSeq}`, resultados del gateway (ACCEPTED, DRY_RUN, UNCERTAIN, UNAVAILABLE, DEFINITIVE_ERROR, `AuditUnavailableError`), repetición con la misma clave y JSON, retransmisión por ventana vencida con clave nueva, avisos de lote, `ackResendEnabled`.
- [x] **T5. Asignaciones.** `assignmentCycle.ts`: inicio (ventana, empresa, unidad única, `routeType` 1 con alerta única), cierre por no vigencia (filas 8 y 10 con `getById`), espaciado adaptativo.
- [x] **T6. Tramas.** `chainPoller.ts`: solo equipos en espera, secuencial, `hasMore` (máx. 5), `decodeFrame` + `parseMessage`, cursor guardado solo tras aplicar el lote, prueba de `getPlan` que falla y se recupera sin perder la salida, alertas del lector conectadas por 006.
- [x] **T7. Arranque y recuperación.** `orchestrator.ts`: `start()` con la tabla de “Arranque y reinicio”, índice `unitId → assignmentId`, sin duplicar temporizadores; `stop()` ordenado.
- [x] **T8. Adaptador BullMQ.** `bullmqScheduler.ts` sobre la interfaz, con `jobId` deterministas y `removeOnComplete`/`removeOnFail`. Prueba unitaria del traductor de ids; sin prueba de integración con Redis en memoria.
- [x] **T9. Ruta completa.** Prueba de punta a punta con fakes: ruta de 2 puntos hasta `COMPLETED`; modo sombra hasta `AWAITING_ACK`; reinicio a mitad de ruta.
- [x] **T10. Entrada pública.** `index.ts` exporta solo lo de la spec.
- [x] **T11. Cierre.** `npm run lint`, `npm run build` y `npm test` completos en verde. Fila de 002 en `AGENTS.md` actualizada (solo esa). Commit.
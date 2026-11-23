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
- [x] **T12. Enmienda de estados.** Quitar `startMarginMinutes`; usar `isActiveAssignment` de 001 en inicio, cierre y retransmisión; probar espera de 1, inicio en 3/4, continuidad 3 ↔ 4, cierres y retransmisión del reset. La condición previa sobre `horaFinal` se retira en T13.
- [x] **T13. Hora final y aislamiento.** Quitar `horaFinal` de inicio; `try/catch` por asignación y `failedAssignments`; usar `describeError` de `src/common/` en los registros de 002. Pruebas de inicio con `null`/pasado/futuro, continuidad entre asignaciones y causas redactadas.
- [x] **T14. Límite SQL.** Crear y exportar `ChainQueryLimiter`: una consulta en vuelo, espaciado y ventana móvil, tasa decimal, retroceso por fallos y métricas; pruebas de 30 `initCursor` simultáneos y consultas múltiples por llamada.
- [x] **T15. Cola por equipo.** Sustituir el barrido por `nextPollAt`, orden del vencido, reparto uniforme, `hasMore` reencolado y primer turno inmediato. Probar 60 equipos/10 min y 200 saturados sin ráfagas.
- [x] **T16. Independencia y registros.** Inicios de ruta pendientes sin bloquear asignaciones, vigencia al transmitir, parada ordenada, `chain_poll_saturated` y `chain_poll_summary` por minuto; pruebas de fallos, rezago y ausencia de `chain_poll`.
- [x] **T17. Cierre de enmienda.** `npm run lint`, `npm run build`, `npm test`, revisión de referencias antiguas y commit. Conservar `AGENTS.md` y `legacy/` intactos.

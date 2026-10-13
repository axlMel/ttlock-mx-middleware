# Tasks — 002-queue-orchestrator

- [x] Añadir `bullmq` a las dependencias de la raíz y actualizar el lockfile (la conexión de `ioredis` para BullMQ usa `maxRetriesPerRequest: null`).
- [x] Crear `src/orchestrator/types.ts` con `DomainEvent` (reutiliza `RouteState` de 004).
- [x] Implementar `fsm.ts`: función pura `transition()` con las 10 filas de la tabla de transiciones de la spec.
- [x] Actualizar primero los contratos y pruebas de 004 para `lastCommandSentAt: null` y `RouteStateStore.list()`.
- [x] Escribir `fsm.test.ts`: un caso por fila de la tabla, más eventos ignorados y salida sin entrada previa.
- [x] Implementar en `worker.ts` la cola `site-lifecycle` y los handlers `poll-routes`, `poll-reports` y `send-command`.
- [x] Implementar los reintentos de ACK por lotes continuos: `attempts = ACK_MAX_RETRIES + 1`, backoff fijo `ACK_RETRY_BACKOFF_MS`, verificación de estado antes de cada reenvío, `warn` y siguiente lote al agotar el actual. Sin estado `FAILED` ni pausa.
- [x] Implementar el polling adaptativo por reencolado (base con novedad; doble hasta 5× sin novedad o con error; intervalo base mientras algún equipo espere eventos).
- [x] Implementar el ciclo de vida de `RouteState`: creación por IMEI nuevo, conservación (incluso en `COMPLETED`) mientras siga vigente, eliminación al dejar de estar vigente en `COMPLETED`.
- [x] Implementar el paso de reset (`currentSiteIndex` igual al total de sitios) con el mismo ciclo de ACK; `COMPLETED` solo tras su ACK.
- [x] Implementar arranque: drenar el historial de `reporte_cadenas` si no hay cursor, y reanudar los `RouteState` en `PENDING`/`CONFIGURING`/`AWAITING_ACK` sin duplicar cadenas.
- [x] Verificar cómo 001 avanza el cursor y anotar la limitación en la spec si lo avanza antes de aplicar los eventos (sin modificar 001).
- [x] Documentar en la spec de 002 el riesgo de ACKs y salidas tardíos, y la semántica informativa de `retryCount`.
- [x] Registrar con `timestamp`, `deviceId` y `routeId` cada transición y comando; `warn` por lote agotado; traza de cada ciclo de polling.
- [x] Escribir `worker.test.ts` con fakes de 001, 003, 005 y de la cola, cubriendo los criterios de aceptación de la spec.
- [x] Confirmar `npm test` (pruebas nuevas de 002 y todas las existentes) y `npm run lint` sin errores.
- [x] En `AGENTS.md`: retirar `POLL_INTERVAL_MS_ALERTS` (sin uso), añadir en la sección de la FSM que los reintentos de ACK son continuos y que no existe estado `FAILED` ni pausa para operador, y actualizar el estado de 002 a "Implementado".
- [x] Marcar esta lista como completa.
- [x] Si falla `orchestrator.start()` dentro de `startBullWorker`, cerrar
      worker, cola y conexión Redis; probar el caso con fakes, sin modificar
      la política de reintentos ni las transiciones.

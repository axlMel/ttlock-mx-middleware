# Tasks — 002-queue-orchestrator

- [ ] Crear `src/orchestrator/types.ts` con `DomainEvent` (reutiliza `RouteState` de 004).
- [ ] Implementar `fsm.ts`: función pura `transition()` con las 6 transiciones documentadas en spec.md.
- [ ] Escribir `fsm.test.ts`: tabla de casos cubriendo las 6 transiciones, el reintento de ACK, y el reset final.
- [ ] Implementar `worker.ts`: integración con BullMQ + 001/003/004/005, incluyendo el logging de `{timestamp, deviceId, routeId}` en cada envío y transición.
- [ ] Implementar intervalo adaptativo de consulta (reencolado, no intervalo fijo) para `routeDetector.getActiveRoutes` y `chainReportDetector.getNewEvents`: intervalo base al haber resultados, espaciado progresivo (tope 5x) si no hay resultados o si falla la consulta — con logging en cada ciclo. Esta tarea es independiente de los reintentos de ACK (tarea de abajo): ninguna de las dos cancela ni afecta a la otra.
- [ ] Escribir `worker.test.ts` con fakes de las 4 dependencias.
- [ ] Confirmar `npm test` en verde y el linter sin errores.
- [ ] Marcar esta lista como completa y actualizar el estado de 002 en `AGENTS.md` a "Implementado".
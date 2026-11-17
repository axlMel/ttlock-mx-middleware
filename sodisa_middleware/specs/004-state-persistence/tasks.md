# Tasks — 004-state-persistence

## Transición (primera tarea de la tanda 1)
- [x] Verificar que las carpetas `legacy/event-detectors`, `legacy/orchestrator` y `legacy/app` ya fueron movidas por la persona responsable del repo. Si no, detenerse y avisar.
- [x] Excluir `legacy/` de `tsconfig.json`, `tsconfig.build.json`, Jest y ESLint, y confirmar que `npm run build`, `npm test` y `npm run lint` corren en verde sin las pruebas de `legacy/`. No modificar nada dentro de `legacy/`.

## Módulo
- [x] Reemplazar `src/persistence/types.ts` con `FsmState`, `PendingRequest`, `RouteState` (con `routeType`), `ChainCursor`, `CatalogEntry` y `CorruptStateError`.
- [x] Crear `src/persistence/keys.ts` con `routeKey`, `deviceRouteKey`, `chainCursorKey` y `catalogKey`.
- [x] Reescribir `routeStateStore.ts` con `get`, `getByDevice`, `set`, `delete` y `list`, usando `multi` para `set`/`delete`, `scan` para `list` y el callback opcional `onCorrupt`.
- [x] Reemplazar `cursorStore.ts` por `chainCursorStore.ts` (`get`, `set`, `delete` por `deviceId`) y retirar `PollingCursorStore`.
- [x] Crear `catalogCacheStore.ts` (`get`, `set`, `delete` por entidad e id).
- [x] Crear `src/persistence/index.ts` como entrada pública de tipos, interfaces, implementaciones y `CorruptStateError`.
- [x] Reescribir `persistence.test.ts` con los casos del plan: tres stores, `routeType`, `FsmState` sin `FAILED` ni `PAUSED`, e índice `device-route:` consistente.
- [x] Probar el manejo de JSON corrupto: `get` lanza `CorruptStateError`; `list()` omite la llave, llama a `onCorrupt` y devuelve las demás.
- [x] Confirmar que `npm test` y `npm run lint` pasan, sin red, BD ni Docker.
- [x] Anotar en `plan.md` cualquier ajuste que haya sido necesario (por ejemplo, si `ioredis-mock` no soporta `multi`). No hubo ajustes: `ioredis-mock` soportó `multi`.
- [x] Marcar esta lista como completa y actualizar la fila de 004 en la tabla de `AGENTS.md` a "Implementado".

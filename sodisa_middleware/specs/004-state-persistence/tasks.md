# Tasks — 004-state-persistence
 
- [x] Crear `src/persistence/types.ts` con `RouteState` y `FsmState`.
- [x] Implementar `RouteStateStore` (`get`/`set`/`delete`) en `routeStateStore.ts` usando `ioredis`.
- [x] Implementar `PollingCursorStore` (`get`/`set`) en `cursorStore.ts` usando `ioredis`.
- [x] Instalar `ioredis-mock` como devDependency.
- [x] Escribir tests en `persistence.test.ts`: guardar/leer `RouteState`, leer inexistente → `null`, eliminar y confirmar `null`, guardar/leer cursor, leer cursor inexistente → `null`.
- [x] Confirmar `npm test` en verde y el linter sin errores.
- [x] Agregar en `docs/architecture.md` el requisito de `appendonly yes` en la configuración de Redis para despliegue.
- [x] Marcar esta lista como completa y actualizar el estado de 004 en `AGENTS.md` a "Implementado".
 

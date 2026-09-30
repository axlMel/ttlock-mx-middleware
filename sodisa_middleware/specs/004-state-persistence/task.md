# Tasks — 004-state-persistence
 
- [ ] Crear `src/persistence/types.ts` con `RouteState` y `FsmState`.
- [ ] Implementar `RouteStateStore` (`get`/`set`/`delete`) en `routeStateStore.ts` usando `ioredis`.
- [ ] Implementar `PollingCursorStore` (`get`/`set`) en `cursorStore.ts` usando `ioredis`.
- [ ] Instalar `ioredis-mock` como devDependency.
- [ ] Escribir tests en `persistence.test.ts`: guardar/leer `RouteState`, leer inexistente → `null`, eliminar y confirmar `null`, guardar/leer cursor, leer cursor inexistente → `null`.
- [ ] Confirmar `npm test` en verde y el linter sin errores.
- [ ] Agregar en `docs/architecture.md` el requisito de `appendonly yes` en la configuración de Redis para despliegue.
- [ ] Marcar esta lista como completa y actualizar el estado de 004 en `AGENTS.md` a "Implementado".
 
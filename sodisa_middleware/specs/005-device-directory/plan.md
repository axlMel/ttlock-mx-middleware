# Plan 005 — Catálogo local

## Decisiones
1. **Dos servicios pequeños**, `DeviceDirectory` y `RoutePlanRepository`, sobre un `SqlClient` mínimo. El pool lo crea el arranque; así las pruebas inyectan un cliente falso.
2. **Sin JOINs, una consulta por llave.** Es la política de ElevenMinds (constitución IX). El costo son más consultas, que la caché absorbe.
3. **El tipo de ruta se lee primero (R1).** Si es 1 no se pide nada más: no se carga a la BD por una ruta que v1 no procesa.
4. **Unidad y dispositivo sin caché.** Se leen una vez al iniciar la ruta y el resultado queda en el `RouteState` (spec 004).
5. **Mapa de modelos estático** en `modelMap.ts`. Agregar un modelo = una línea aquí + un perfil en `specs/003`.
6. **Reloj inyectable** (`now()`) para probar la revalidación sin esperas.
7. **Errores tipados en español**, siempre con ids, para que el orquestador los registre sin reinterpretar.
8. Se usa `CatalogCacheStore` tal como quedó en `src/persistence/` (spec 004); no se redefine su contrato.

## Estructura
```
src/catalog/
  types.ts            SqlClient, UnitDevice, RoutePlan, RoutePlanPoint, interfaces
  errors.ts           UnknownModelError, UnitValidationError, InvalidPlanError
  modelMap.ts         25 -> GV300W, 100 -> GV310LAU
  deviceDirectory.ts  U1, U2
  routePlanRepository.ts  R1, P1, S1 + caché + validación de radio
  index.ts            única entrada pública
  __fixtures__/       filas con los ids reales (empresa 364, ruta 1410255, sitios 1389019-21, unidad 224979, dispositivo 70177)
  catalog.test.ts
```

## Orden de trabajo
Tipos y errores → mapa de modelos → `DeviceDirectory` → `RoutePlanRepository` sin caché → caché y `forceFresh` → prueba de SQL (sin JOIN ni `SELECT *`) → limpieza de Docker local.

## Riesgos
- Si el contenido de una ruta cambia a mitad de viaje, lo detecta `forceFresh` en cada cambio de paso; el orquestador (spec 002) decide qué hacer con la diferencia.
- `bol_enuso = false` en un punto lo excluye del plan; si eso deja la ruta incompleta a mitad de viaje, lo maneja 002 al comparar planes.
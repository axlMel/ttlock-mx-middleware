# Tasks 005 — Catálogo local

- [x] **T1. Tipos y errores.** `types.ts`, `errors.ts`.
- [x] **T2. Mapa de modelos.** `modelMap.ts` con 25 y 100; id desconocido → `UnknownModelError`. Prueba.
- [x] **T3. DeviceDirectory.** U1 y U2 con todas las validaciones de la spec. Pruebas: ambos modelos, modelo desconocido, unidad inexistente, unidad o dispositivo fuera de uso, empresa distinta.
- [x] **T4. Fixtures.** Filas de ejemplo con los ids reales (empresa 364, ruta 1410255, sitios 1389019, 1389020, 1389021, unidad 224979, dispositivo 70177) y una ruta de tipo 1.
- [x] **T5. RoutePlanRepository sin caché.** R1, P1, S1; orden por `int_orden` con desempate; ruta tipo 1 sin P1 ni S1; radio; coordenadas; errores. Pruebas por cada regla.
- [x] **T6. Caché.** Cache-aside con `CatalogCacheStore`, `CATALOG_REVALIDATE_MS`, `forceFresh`, registro de “cambio detectado”. Reloj inyectable. Pruebas con Redis en memoria.
- [x] **T7. Sin JOIN ni `SELECT *`.** Prueba sobre las cadenas SQL de `src/catalog/`.
- [x] **T8. Entrada pública.** `index.ts` exporta solo lo de la spec.
- [x] **T9. Retiro de lo local.** Eliminar `docker-compose.yml` y `local-db/`; dejar `.env.example` solo con las variables de `docs/architecture.md` §7 (sin valores locales ni Docker). Si `AGENTS.md` o `package.json` mencionan Docker o los scripts locales, **no editar `AGENTS.md`**: listar las líneas en el resumen final para que las cambie el humano; sí limpiar los scripts de `package.json`.
- [x] **T10. Cierre.** `npm run lint`, `npm run build` y `npm test` completos en verde. Fila de 005 en `AGENTS.md` actualizada (solo esa). Commit.

# Tasks — 005-device-directory

- [x] Levantar `docker-compose.yml` (Postgres + seed) si no está corriendo ya.
- [x] Verificar que el seed local incluya los dos IMEIs reales y el IMEI ficticio con modelo no reconocido.
- [x] Crear `src/device-directory/types.ts` con `DeviceDirectoryEntry`.
- [x] Implementar `deviceDirectory.ts` con `pg`, incluyendo el mapeo modelo→perfil y los errores explícitos (`UnknownDeviceError`, modelo no reconocido).
- [x] Escribir tests de integración contra la BD local con los 2 IMEIs sembrados.
- [x] Confirmar `npm test` en verde y el linter sin errores.
- [x] Marcar esta lista como completa y actualizar el estado de 005 en `AGENTS.md` a "Implementado (esquema local, pendiente confirmar real)".

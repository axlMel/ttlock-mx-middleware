# Tasks — 003-queclink-protocol
 
- [x] Crear `src/protocol/types.ts` con `DeviceProfile`, `GeoParams`, `ParsedMessage`.
- [x] Crear `src/protocol/profiles.ts` con `GV300W_PROFILE` y `GV310LAU_PROFILE`.
- [x] Implementar `buildGeoCommand(profile, params)` en `command.ts`.
- [x] Implementar el caso de reset (`mode: 0`) como parte de `buildGeoCommand`, no como función aparte.
- [x] Implementar `parseMessage(profile, raw)` en `parser.ts`, con las dos ramas: familia GTGEO (GV300W) y familia GTGIN/GTGOT (GV310LAU).
- [x] Implementar `sendGeoCommand(host, port, command)` en `transport.ts` con `dgram`.
- [x] Escribir tests en `protocol.test.ts` con las 6 cadenas reales del `spec.md` como fixtures, más el caso de reset y un caso de cadena desconocida.
- [x] Confirmar `npm test` en verde y el linter sin errores.
- [x] Marcar esta lista como completa y actualizar el estado de 003 en `AGENTS.md` a "Implementado".

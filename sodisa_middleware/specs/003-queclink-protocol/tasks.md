# Tasks 003 — Protocolo Queclink

- [x] **Enmienda GTOUT.** Armar el apagado de salida 2 con serial validado, identificar el comando en cada ACK y probar cuatro tramas reales `GTOUT` como fixtures.

- [x] **Enmienda de salida 2 y fixtures reales.** Sustituir el formato de `buildOutOffCommand`, reemplazar los tres fixtures sintéticos por tramas físicas de ambos modelos y agregar la cuarta; verificar los comandos exactos, los índices del parser y el serial inválido. Ejecutar lint, build y tests y cerrar en el mismo commit.

- [x] **T1. Fixtures.** Copiar tal cual las siete tramas reales de la sección “Tramas reales de referencia” de la spec a `src/protocol/__fixtures__/`. Los índices de campo de la spec ya están verificados contra ellas; el agente solo los implementa.
- [x] **T2. Tipos y errores.** `types.ts`, `errors.ts`.
- [x] **T3. Perfiles.** `profiles.ts` con `PROFILES` y `profileFor`.
- [x] **T4. Armado.** `buildGeoCommand`, `buildResetCommand`, `RESET_PARAMS`, con toda la validación de la spec. Pruebas: comando exacto por modelo, 6 decimales, orden lon/lat, una prueba por regla de validación.
- [x] **T5. Decodificación.** `decodeFrame` con prueba sobre un `Buffer`.
- [x] **T6. Lectura.** `parseMessage` con las cuatro clases de trama y `unknown`. Pruebas: fixtures reales, `A1` sintético, máscara del LAU, `$` opcional, basura/vacío/truncado sin lanzar.
- [x] **T7. Entrada pública.** `index.ts` exporta solo lo de la spec.
- [x] **T8. Sin red.** Prueba que revisa los imports de `src/protocol/` (sin `dgram`, `net`, `http`, `https`, `fetch`).
- [x] **T9. Limpieza.** Eliminar el transporte UDP antiguo y su prueba; confirmar que no queda ninguna referencia en `src/`.
- [x] **T10. Cierre.** `npm run lint`, `npm run build` y `npm test` en verde. Fila de 003 en `AGENTS.md` actualizada. Commit.

# Plan 003 — Protocolo Queclink

## Enmienda de apagado de salida
`buildOutOffCommand` reutiliza la validación de serial de `GTGEO` y el token del perfil. `parseMessage` distingue el encabezado de cada ACK antes de escoger el índice del serial: 5 para `GTGEO`, 4 para `GTOUT`. Tres fixtures `GTOUT` cubren el campo 4; el índice de GV310LAU requiere comprobación en equipo real.

## Decisiones
1. **Funciones libres y datos, no clases.** `DeviceProfile` es un objeto de datos; `buildGeoCommand(profile, input)` es una función. (Si spec y plan chocaran, gana este razonamiento: perfiles como datos permiten añadir un modelo sin tocar la lógica.)
2. **Validar en un solo lugar.** `buildGeoCommand` valida y lanza; los demás módulos no repiten reglas.
3. **El parser no lanza.** Cualquier cosa inesperada es `unknown`; así una trama rara jamás detiene el poller.
4. **`RESET_PARAMS` constante exportada.** El reset se arma con ella, no con valores sueltos.
5. **Sin transporte.** Se elimina cualquier código `dgram`/`sendGeoCommand` previo del módulo.
6. **Índices de campo como constantes con nombre** en `parseMessage.ts` (p. ej. `IDX_IMEI`), para que corregir un índice sea un cambio de una línea.

## Estructura
```
src/protocol/
  types.ts            tipos de la spec
  errors.ts           InvalidCommandInputError
  profiles.ts         PROFILES, profileFor
  buildGeoCommand.ts  validación + armado + buildResetCommand + RESET_PARAMS
  decodeFrame.ts
  parseMessage.ts
  index.ts            única entrada pública
  __fixtures__/       tramas reales (texto) de los dos modelos
  protocol.test.ts
```
Si hay código anterior de protocolo en `legacy/`, el agente puede leerlo como referencia, pero no importarlo ni modificarlo.

## Orden de trabajo
Fixtures y confirmación de índices → tipos y errores → armado (con pruebas) → lectura (con pruebas) → prueba de “sin red” → limpieza del transporte antiguo.

## Riesgos
- Los índices de campo ya están verificados contra las siete tramas reales (ver spec); las pruebas de fixtures los protegen de regresiones.
- Ancho del id de zona GV300W para ids 16 a 19: fuera de v1 (solo zona 0); se verifica en `specs/009`.
- Modo 0 (State Mode) podría reportar salida inmediata si se configura fuera de la zona: no es de este módulo; se verifica en la prueba de campo.
- GV310LAU: formato de GTGEO desordenado pendiente (spec 009).

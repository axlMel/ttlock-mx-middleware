# Plan — 003-queclink-protocol
 
## Estructura de archivos
```
src/protocol/
  types.ts          // DeviceProfile, GeoParams, ParsedMessage
  profiles.ts       // GV300W_PROFILE, GV310LAU_PROFILE (datos, no lógica)
  command.ts        // buildGeoCommand(profile, params) — función pura
  parser.ts         // parseMessage(profile, raw) — función pura
  transport.ts       // sendGeoCommand(host, port, command) — único punto de I/O
  protocol.test.ts   // tests con las 6 cadenas reales del spec.md como fixtures
```
 
## Decisiones técnicas
- **Sin librerías externas.** `dgram` (nativo de Node) cubre el envío; el
  resto es manipulación de strings con funciones puras de TypeScript.
- **Perfiles como datos, no clases.** `GV300W_PROFILE` y `GV310LAU_PROFILE`
  son objetos planos (`commandDeviceName`, nombres de reporte, defaults).
  Añadir un tercer modelo a futuro es agregar un objeto, no tocar lógica.
- **`command.ts` y `parser.ts` no importan `dgram` ni nada de I/O** —
  cumplen el principio III de la constitución: testeables sin red, BD ni
  variables de entorno.
- **`transport.ts` es la única pieza con I/O real** de este módulo. Su
  verificación principal es la prueba de campo (ya hecha para ambos
  modelos); el test unitario solo confirma que llama a `dgram` con los
  argumentos correctos (mock del socket, no un socket real).
## Testing
- Jest. Fixtures = las 6 cadenas reales documentadas en `spec.md`,
  copiadas literalmente como constantes en el archivo de test — nunca
  generadas ni inventadas.
- Un caso de test por cadena real: arma o parsea, compara contra el valor
  esperado exacto (comparación de string completa, no parcial).
- Casos adicionales: comando de reset (`mode=0`) para ambos modelos, y al
  menos un caso de cadena desconocida/malformada → `{ kind: 'unknown' }`.
## Alternativas descartadas
- **Regex genérico / gramática formal para parsear:** descartado. El
  formato es un simple split por comas; una librería de parsing añadiría
  una dependencia sin necesidad real (principio I).
- **Clases con herencia por modelo** (`GV310LAUDevice extends BaseDevice`):
  descartado a favor de perfiles-como-datos + funciones puras — más simple
  de testear, de leer y de extender con un tercer modelo.
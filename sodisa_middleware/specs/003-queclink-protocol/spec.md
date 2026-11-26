# Spec 003 — Protocolo Queclink (armado de comandos y lectura de tramas)

## Objetivo
Módulo de funciones puras que (1) arma los comandos `AT+GTGEO` y `AT+GTOUT` para cada modelo y (2) interpreta
las tramas `+ACK` y de evento de zona. No envía nada: el envío es de `specs/007`.

## Fuera de alcance
- Transporte (UDP, HTTP) → no existe aquí. El módulo **no importa** `dgram`, `net`, `http`, `https` ni `fetch`.
- Política de reintentos, números de serie y estados → `specs/002`.
- Rutas desordenadas (`AT+GTUDF`, `AT+GTCMD`) → futura `specs/009`. Aquí solo quedan los ganchos descritos abajo.

## Interfaces
```typescript
type ModelName = 'GV300W' | 'GV310LAU';

interface DeviceProfile {
  model: ModelName;
  token: string;        // 'gv300w' | 'gv310lau' (primer campo del comando)
  tailFields: string;   // campos reservados antes del serial: ',,'  o  '0000,0000'
}
const PROFILES: Record<ModelName, DeviceProfile>;
function profileFor(model: ModelName): DeviceProfile;

interface GeoCommandInput {
  latitude: number; longitude: number; radiusM: number;
  mode: 0 | 1 | 2 | 3;
  serial: string;          // ^[0-9A-F]{4}$
  zoneId?: number;         // 0..19, por defecto 0   (gancho rutas desordenadas)
  checkIntervalS?: number; // por defecto 30          (gancho rutas desordenadas)
}
function buildGeoCommand(profile: DeviceProfile, input: GeoCommandInput): string;

const RESET_PARAMS: { latitude: 0; longitude: 0; radiusM: 50; mode: 0 };
function buildResetCommand(profile: DeviceProfile, serial: string, zoneId?: number): string;
function buildOutOffCommand(profile: DeviceProfile, serial: string): string;

function decodeFrame(raw: Buffer): string;   // bytea_mensaje -> texto

type ParsedMessage =
  | { kind: 'ack'; command: 'GTGEO' | 'GTOUT'; imei: string; serial: string; raw: string }
  | { kind: 'zoneEvent'; imei: string; geofenceId: number; event: 'enter' | 'exit'; raw: string }
  | { kind: 'unknown'; raw: string };
function parseMessage(text: string): ParsedMessage;

class InvalidCommandInputError extends Error {}
```
Todo se exporta desde `src/protocol/index.ts`; es lo único que otros módulos pueden importar.

## Formato de los comandos
```
GV300W   AT+GTGEO=gv300w,{zoneId},{mode},{lon},{lat},{radio},{check},0,0,0,0,0,0,,,0,{serial}$
GV310LAU AT+GTGEO=gv310lau,{zoneId},{mode},{lon},{lat},{radio},{check},0,0,0,0,0,0,0000,0000,0,{serial}$
```
- Orden **lon, lat** (no lat, lon). Coordenadas con exactamente 6 decimales (`toFixed(6)`), punto decimal.
- Ejemplo real GV300W: `AT+GTGEO=gv300w,0,3,-99.128206,19.355383,50,30,0,0,0,0,0,0,,,0,0001$`.
- Reset: mismo comando con `mode 0`, lon/lat `0.000000`, radio `50`.
- Apagado de salida 3: `AT+GTOUT={token},,,,,,,0,,,,,,,,,,{serial}$`. El serial se valida con la misma regla que `GTGEO`.

## Validación de entrada (antes de armar; si falla, `InvalidCommandInputError`)
| Campo | Regla |
|---|---|
| latitude | número finito, −90..90 |
| longitude | número finito, −180..180 |
| radiusM | entero, 50..6 000 000 |
| mode | 0, 1, 2 o 3 |
| serial | `^[0-9A-F]{4}$` |
| zoneId | entero 0..19 |
| checkIntervalS | entero ≥ 0 |
El mensaje del error nombra el campo y el valor recibido (nunca la API key ni datos de otros módulos).

## Lectura de tramas
- `decodeFrame`: decodifica como ASCII/latin1 y recorta espacios y saltos de línea finales. No lanza por bytes extraños.
- `parseMessage` separa por coma. Índices **absolutos, con el encabezado en 0**, verificados contra las tramas reales de campo (sección siguiente):

| Trama | IMEI | Dato clave | Evento |
|---|---|---|---|
| `+ACK:GTGEO` (ambos modelos) | 2 | serial en **5** (hex-4; el campo 4 es un `0` reservado) | — |
| `+ACK:GTOUT` | 2 | serial en **4** (hex-4) | — |
| `+RESP:GTGEO` (GV300W) | 2 | campo **5** = `[id de zona hex][estado]`: `00` → zona 0 sale, `01` → zona 0 entra | último carácter: `1` entra, `0` sale |
| `+RESP:GTGIN` (GV310LAU) | 2 | id de zona en el campo **5** (decimal) | `enter` |
| `+RESP:GTGOT` (GV310LAU) | 2 | id de zona en el campo **5** (decimal) | `exit` |

- GV310LAU: el campo 6 (`1`) es constante en GIN y GOT, no es el estado. El campo 7 (`00000001`) es una máscara de zonas con el bit de la zona activo; coincide con el id del campo 5 (zona 0 ↔ bit 0). El parser usa el campo 5; la prueba de fixtures verifica además que la máscara coincide.
- GV300W: el campo de zona se descompone como “todo menos el último carácter = id en hex; último carácter = estado”. En v1 solo se usa la zona 0; los ids de zona 16 a 19 (rutas desordenadas) no se tratan aquí, porque su ancho en el campo se verifica en `specs/009` con una trama real.
- Una trama de otro tipo, truncada o con campos inválidos devuelve `{ kind: 'unknown', raw }`. **Nunca lanza.**
- El índice del ACK `GTOUT` de GV310LAU está pendiente de comprobarse físicamente; se interpreta igual que el GV300W hasta obtener una trama real.

## Tramas reales de referencia (fixtures)
```
GV300W ACK : +ACK:GTGEO,270D04,863457050476769,,0,FFFF,20260921220939,03C8
GV300W ent.: +RESP:GTGEO,270D04,863457050476769,,,01,1,1,0.0,0,2257.0,-99.127905,19.355447,20260921220959,0334,0020,0336,8F3D,00,0.2,20260921220959,03C9
GV300W sal.: +RESP:GTGEO,270D04,863457050476769,,,00,1,1,3.3,79,2258.0,-99.127571,19.355516,20260921221159,0334,0020,2C1A,90489A1,00,0.2,20260921221159,03CD
LAU ACK    : +ACK:GTGEO,6E0802,135790246811220,GV310LAU,0,000A,20090214093254,11F0$
LAU ACK    : +ACK:GTGEO,6E0A03,868589060960328,,0,FFFF,20260925001304,01CA$
LAU entra  : +RESP:GTGIN,6E0A03,868589060960328,,,0,1,00000001,,,,,1,1,0.0,0,2248.0,-99.128239,19.355355,20260925002252,0334,0020,024A,015FAD2B,00,0.0,20260925002253,01F9$
LAU sale   : +RESP:GTGOT,6E0A03,868589060960328,,,0,1,00000001,,,,,1,1,0.0,0,2249.8,-99.128245,19.355360,20260925002356,0334,0020,024A,015FAD2B,00,0.0,20260925002357,0206$
```
Resultados esperados: ACK GV300W → serial `FFFF`; ACK LAU → `000A` y `FFFF`; GV300W entra → zona 0 `enter`; GV300W sale → zona 0 `exit`; GTGIN → zona 0 `enter`; GTGOT → zona 0 `exit`. El `$` final puede venir o no; el parser lo tolera.

Los tres fixtures de ACK `GTOUT` siguen el formato documentado en arquitectura §14 y ejercitan los seriales `0002`, `FFFF` y `000A`; el último representa GV310LAU de forma sintética hasta disponer de una trama física.

## Ganchos para rutas desordenadas (no se implementa nada más)
- `zoneId` y `checkIntervalS` ya son parámetros (en rutas ordenadas: 0 y 30). Pendiente de `specs/009`: confirmar si en desordenadas el intervalo es 0.
- `parseMessage` devuelve `geofenceId` numérico para poder distinguir zonas.
- Los formatos `AT+GTUDF` de referencia quedan en `docs/architecture.md` §11; no se codifican aquí.

## Criterios de aceptación
- [ ] `buildGeoCommand` produce, byte a byte, el comando esperado para cada modelo (ejemplos reales como fixtures).
- [ ] Coordenadas siempre con 6 decimales y orden lon, lat.
- [ ] `buildResetCommand` usa `RESET_PARAMS` (única fuente) para ambos modelos.
- [ ] `buildOutOffCommand` genera el comando exacto de cada modelo y rechaza seriales inválidos.
- [ ] Los ACK de `GTGEO` y `GTOUT` indican el tipo de comando y usan sus respectivos índices de serial; se prueban tres fixtures de `GTOUT`.
- [ ] Cada fila de la tabla de validación tiene una prueba que lanza `InvalidCommandInputError`.
- [ ] `parseMessage` clasifica los fixtures reales: ACK, entrada y salida de GV300W; GTGIN y GTGOT de GV310LAU.
- [ ] GV300W: `00` → zona 0 exit, `01` → zona 0 enter, y un caso sintético `A1` → zona 10 enter (id de un carácter hex).
- [ ] GV310LAU: la máscara del campo 7 coincide con el id del campo 5 en los fixtures.
- [ ] Un `$` final opcional no cambia el resultado.
- [ ] Tramas basura, vacías o truncadas → `unknown`, sin lanzar.
- [ ] `decodeFrame` recibe un `Buffer` real de `bytea_mensaje`.
- [ ] Prueba que verifica que ningún archivo de `src/protocol/` importa módulos de red.
- [ ] Sin dependencias nuevas; pruebas sin red ni BD.

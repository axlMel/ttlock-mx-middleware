# Spec 007 — Command gateway (API de comandos) y auditoría

> Carpeta `specs/007-command-gateway`; código en `src/gateway/`.

## Objetivo
Enviar un comando a la API de comandos y devolver un resultado clasificado, dejando un registro de
auditoría de cada intento. Es el único módulo que habla con la API.

## Fuera de alcance
- Armado y validación del comando → `specs/003`.
- Política de reintentos, ventanas de ACK y claves de idempotencia → `specs/002`. El gateway hace **un solo intento HTTP por llamada**, sin ciclos.
- Lectura de variables de entorno → arranque (`specs/006`). El gateway recibe sus opciones por parámetro.

## Interfaces
```typescript
interface GatewayRequest {
  assignmentId: number;      // routeId de logs
  deviceId: number;
  unitId: number;
  apiCompanyId: number;
  stepSeq: number;
  transmissionSeq: number;
  idempotencyKey: string;
  command: string;           // AT+GTGEO...$
}

type GatewayResult =
  | { kind: 'ACCEPTED'; httpStatus: 200; apiCommandId: string | null; apiStatus: string } // status no vacío tras trim; commandId informativo
  | { kind: 'DRY_RUN' }
  | { kind: 'UNAVAILABLE'; httpStatus: 503 }
  | { kind: 'DEFINITIVE_ERROR'; httpStatus: number; reason: string }
  | { kind: 'UNCERTAIN'; cause: 'timeout' | 'network' | 'server_error' | 'invalid_response' };

interface CommandGateway { send(req: GatewayRequest): Promise<GatewayResult>; }

interface AuditRecord {
  ts: string; phase: 'INTENT' | 'RESULT';
  assignmentId: number; deviceId: number; unitId: number; apiCompanyId: number;
  stepSeq: number; transmissionSeq: number; idempotencyKey: string; command: string;
  resultKind?: GatewayResult['kind']; httpStatus?: number;
  apiCommandId?: string | null; apiStatus?: string; reason?: string; cause?: string;
  durationMs?: number; dryRun: boolean;
}
interface CommandAuditLog { append(record: AuditRecord): Promise<void>; }

interface GatewayOptions {
  apiUrl: string;            // COMMAND_API_URL, endpoint completo (.../api/v1/commands/send)
  apiKey: string;            // COMMAND_API_KEY
  timeoutMs: number;         // COMMAND_API_TIMEOUT_MS
  dryRun: boolean;           // COMMAND_DRY_RUN
  fetch?: typeof fetch;      // inyectable
  now?: () => number;
}
function createCommandGateway(audit: CommandAuditLog, opts: GatewayOptions): CommandGateway;
function createAuditLog(dir: string, opts?: { now?: () => number }): CommandAuditLog;

class AuditUnavailableError extends Error {}
```
`InvalidCommandInputError` es la de `specs/003` (se importa de `src/protocol`). Todo se exporta desde `src/gateway/index.ts`; es lo único que otros módulos pueden importar.

## Llamada a la API
- `POST {apiUrl}`, que debe ser `https://`; con otro esquema `createCommandGateway` lanza error (la API key viaja en un encabezado).
- Encabezados: `Content-Type: application/json`, `X-API-Key: {apiKey}`, `Idempotency-Key: {idempotencyKey}`.
- Cuerpo: `{ "companyId": apiCompanyId, "unitId": "<unitId como texto>", "comando": command }`.
- `fetch` de Node 20 (sin dependencias nuevas), con `AbortController` y `timeoutMs` que cubre también la lectura del cuerpo. `redirect: 'manual'`: **nunca se siguen redirecciones** (arrastrarían la API key a otro host).
- El comando debe ser ASCII imprimible; si no lo es, se lanza `InvalidCommandInputError` **antes** de auditar o llamar.

## Clasificación de respuestas
| Respuesta | Resultado |
|---|---|
| 200 con JSON objeto que trae `status` (texto no vacío tras recortar espacios); `commandId` opcional | `ACCEPTED` con `apiStatus` tal cual. `commandId` texto se conserva, número finito se convierte a texto y cualquier otro valor produce `apiCommandId: null`. `success`, `unitDbId`, `udpSent`, `ackReceived`, `sentAt` y `message` no intervienen. |
| 200 con cuerpo ilegible, `status` ausente, no textual, vacío o solo espacios | `UNCERTAIN` (`invalid_response`) |
| 503 | `UNAVAILABLE` |
| 401, 403, 404, 409, 422 y otros 4xx | `DEFINITIVE_ERROR` con motivo (código y texto de la API si lo hay) |
| 3xx | `DEFINITIVE_ERROR` (“redirección no permitida”) |
| 5xx distinto de 503 | `UNCERTAIN` (`server_error`) |
| Timeout (abort) | `UNCERTAIN` (`timeout`) |
| Cualquier otro error de red | `UNCERTAIN` (`network`) |

El gateway no interpreta `SENT_UNCONFIRMED` ni `OUTCOME_UNKNOWN`: los devuelve y decide el orquestador. Nunca reintenta.

## Modo sombra
Con `dryRun = true` no hay llamada de red: se escriben los registros `INTENT` y `RESULT` con `dryRun: true` y se devuelve `DRY_RUN`.

## Auditoría
- Archivo JSON Lines por día UTC: `{dir}/audit-YYYY-MM-DD.jsonl`. El directorio se crea si no existe. Solo se agrega; una línea por registro; las escrituras se serializan dentro del proceso.
- Por cada llamada: un `INTENT` **antes** de la llamada y un `RESULT` después.
- El `INTENT` se considera escrito cuando el contenido ya se sincronizó a disco (`fsync`). Si no se puede escribir, **no se envía**: se lanza `AuditUnavailableError` y quien llamó lo reintenta más tarde con alerta.
- Si el `RESULT` no se puede escribir, se registra el error en el log del proceso y se continúa.
- Nunca se escribe la API key, ni en el archivo ni en ningún mensaje de error o log. El comando y la clave de idempotencia sí.
- La retención de archivos la define infraestructura (`logrotate` o equivalente).

## Criterios de aceptación
- [ ] Una llamada correcta arma la petición exacta: URL, tres encabezados, `redirect: 'manual'` y cuerpo con `unitId` como texto.
- [ ] Cada fila de la tabla de clasificación tiene una prueba con una respuesta simulada (incluidos 3xx, `status` ausente y cuerpo no JSON).
- [ ] `OUTCOME_UNKNOWN` se devuelve como `ACCEPTED` con ese `apiStatus`.
- [ ] Timeout → `UNCERTAIN/timeout`; error de red → `UNCERTAIN/network`.
- [ ] Un comando no ASCII lanza `InvalidCommandInputError` sin auditar ni llamar.
- [ ] Una `apiUrl` que no sea `https://` lanza error al crear el gateway.
- [ ] Con `dryRun = true` no se invoca `fetch` y quedan `INTENT` y `RESULT` con `dryRun: true`.
- [ ] Hay un `INTENT` antes de cada llamada y un `RESULT` después, con los mismos `idempotencyKey` y `command`.
- [ ] Si falla la escritura del `INTENT`, no se invoca `fetch` y se lanza `AuditUnavailableError`.
- [ ] Si falla la escritura del `RESULT`, el resultado se devuelve igual.
- [ ] La API key no aparece en el archivo de auditoría, ni en mensajes de error ni en logs (prueba con la clave como valor reconocible).
- [ ] Un envío por día UTC crea el archivo `audit-YYYY-MM-DD.jsonl` del día correcto (reloj inyectado).
- [ ] Las pruebas usan un `fetch` falso y un directorio temporal; no hay red real.

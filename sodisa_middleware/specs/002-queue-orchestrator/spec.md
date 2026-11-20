# Spec 002 — Orquestador (FSM por asignación)

> Carpeta `specs/002-queue-orchestrator`; código en `src/orchestrator/`.

## Objetivo
Avanzar cada asignación vigente: iniciarla cuando corresponda, configurar el punto actual en el equipo
(vía la API de comandos), confirmar su ACK, detectar la salida de zona, pasar al siguiente punto y
cerrar la ruta desactivando la zona.

## Principio rector
Este middleware corre sin interfaz ni operador. Por eso:
- **Nunca se rinde:** un comando sin ACK se retransmite indefinidamente. No existe estado `FAILED` ni pausa para operador.
- **Nunca salta un punto:** avanza solo tras el ACK y la salida de zona del punto actual.
- **Nunca se detiene por un error:** un fallo en un equipo, en la API o en una consulta se registra y no afecta a otros equipos ni al siguiente ciclo.

## Módulos que usa
001 (asignaciones y tramas), 003 (comandos y lectura de tramas), 004 (estado), 005 (unidad y plan), 007 (API y auditoría), y `src/common/` (descripción segura de errores). Solo a través de sus `index.ts`.

## Interfaces
```typescript
interface Logger { debug|info|warn|error(event: string, fields?: Record<string, unknown>): void }

interface OrchestratorOptions {
  enabledCompanies: Map<number, number>;   // plataforma -> companyId de la API (ENABLED_COMPANIES)
  pollIntervalMsRoutes: number;            // POLL_INTERVAL_MS_ROUTES
  pollIntervalMsAck: number;               // POLL_INTERVAL_MS_ACK
  ackRetryBackoffMs: number;               // ACK_RETRY_BACKOFF_MS
  ackMaxRetries: number;                   // ACK_MAX_RETRIES (por lote)
  ackResendEnabled: boolean;               // ACK_RESEND_ENABLED
  dryRun: boolean;                         // COMMAND_DRY_RUN; mismo valor que recibe el gateway desde 006
  now?: () => number;
}
interface OrchestratorDeps {
  detectors: { assignments: AssignmentDetector; chains: ChainReader };   // 001
  catalog: { devices: DeviceDirectory; plans: RoutePlanRepository };     // 005
  gateway: CommandGateway;                                               // 007
  routeStates: RouteStateStore; cursors: ChainCursorStore;               // 004
  scheduler: Scheduler; logger: Logger;
}
interface Orchestrator { start(): Promise<void>; stop(): Promise<void>; }
function createOrchestrator(deps: OrchestratorDeps, opts: OrchestratorOptions): Orchestrator;

// Abstracción de temporizadores por paso (implementada con BullMQ y con un falso para pruebas)
interface Scheduler {
  schedule(jobId: string, delayMs: number, task: StepTask): Promise<void>;  // mismo jobId = no duplica
  cancel(jobId: string): Promise<void>;
  onTask(handler: (task: StepTask) => Promise<void>): void;
  close(): Promise<void>;
}
type StepTask =
  | { kind: 'ACK_DEADLINE'; assignmentId: number; stepSeq: number; transmissionSeq: number }
  | { kind: 'API_RETRY';    assignmentId: number; stepSeq: number; transmissionSeq: number; attempt: number };
```
Todo se exporta desde `src/orchestrator/index.ts`; es lo único que otros módulos pueden importar.
`src/common/index.ts` exporta `describeError(error: unknown): { errorName: string; errorCode?: string; errorMessage: string }` para 002 y 006. `errorName` es `error.name` para `Error`, o `typeof` en otro caso; `errorCode` es el código textual o numérico convertido a texto. `errorMessage` usa el mensaje del error, redacta credenciales de URL (`://usuario:clave@` → `://***@`) y **después** trunca a 200 caracteres.

## Vigencia e inicio
- **Vigente** ⇔ `isActiveAssignment(row)` de 001: `bol_enuso` e `int_estado` ∈ {3, 4}. El estado 1 espera; `bol_enuso = false` equivale a asignación eliminada.
- **Inicio de ruta**: asignación vigente, empresa habilitada y sin `RouteState`. La hora final no interviene: solo se llena cuando la asignación termina, y la vigencia la decide el estado.
- **Continuidad:** el paso de 3 a 4 (o de 4 a 3) con la ruta en curso no cierra ni reinicia nada; sigue el mismo `RouteState`, `stepSeq` y temporizadores.
- Una asignación vigente por unidad. Si ya hay una en curso para la unidad, la otra se ignora con aviso hasta que la primera cierre. Si ninguna ha iniciado, se elige la de menor `horaInicial` y, en empate, la de menor `assignmentId`. Para esto se mantiene en memoria un índice `unitId → assignmentId`, reconstruido con `list()` al arrancar.
- **Al iniciar** (en este orden): `resolveForRouteStart` (005) → `getPlan` con `forceFresh` (005) → si `routeType = 1`: alerta `ROUTE_TYPE_UNORDERED_SKIPPED` (una vez por asignación mientras siga vigente, sin persistir) y **no se crea estado** → `initCursor` (001) y guardarlo → crear el `RouteState` (`PENDING`, `stepSeq = 0`, `currentPointId` = primer punto, `routeType = 0`). Si algo falla (modelo desconocido, plan inválido, unidad inválida), se registra la alerta, **no se crea estado** y se reintenta en el siguiente ciclo.
- El cursor del equipo se inicializa **antes** de la primera transmisión, para ignorar tramas anteriores.

## Estados
| Estado | Significado |
|---|---|
| `PENDING` | El paso actual aún no se ha transmitido. |
| `CONFIGURING` | Se está transmitiendo el comando del paso actual a la API. |
| `AWAITING_ACK` | La API aceptó la transmisión; se espera el ACK del equipo. |
| `IN_ZONE` | ACK recibido; zona activa; se espera entrada o salida. |
| `AWAITING_EXIT_ALERT` | Entrada registrada; se espera la salida. |
| `COMPLETED` | Ruta terminada y zona desactivada (ACK del reset). |

Un **paso** es un punto de la ruta o el **paso de reset** (`currentPointId = null`).
`stepSeq` cuenta los pasos (empieza en 0) y su hexadecimal en mayúsculas de 4 dígitos es el **serial** del comando. Todas las transmisiones de un mismo paso usan el mismo serial.
Comandos: punto → `buildGeoCommand` con modo 3 (entra y sale), zona 0 y los datos del punto; reset → `buildResetCommand` (003).

## Transiciones
| # | Estado | Evento | Estado nuevo | Efecto |
|---|---|---|---|---|
| 1 | (sin estado) | asignación elegible | `PENDING` | ver "Al iniciar" |
| 2 | `PENDING` | paso listo | `CONFIGURING` | se arma el comando (003), `transmissionSeq = 1`, se guarda `pendingRequest` con clave nueva y se llama al gateway |
| 3 | `CONFIGURING` | gateway `ACCEPTED` o `DRY_RUN` | `AWAITING_ACK` | se guarda `lastAcceptedCommand` con el comando del paso y se limpia `pendingRequest`; con `opts.dryRun = false`, `ackDeadline = ahora + ackRetryBackoffMs` y se programa `ACK_DEADLINE`; con `opts.dryRun = true`, `ackDeadline = null` y no se programa |
| 4 | `CONFIGURING` (con `pendingRequest`) o `AWAITING_ACK` | `ack` con el serial del paso | `IN_ZONE`, o fila 9 si es el paso de reset | se descartan `pendingRequest` y `lastAcceptedCommand`; se cancelan temporizadores del paso |
| 5 | `AWAITING_ACK` | `ackDeadline` vencido sin ACK | `CONFIGURING` | `transmissionSeq + 1`, `retryCount + 1`, clave nueva (ver "Retransmisión") |
| 6 | `IN_ZONE` | `zoneEvent` entrada | `AWAITING_EXIT_ALERT` | informativo |
| 7 | `IN_ZONE` o `AWAITING_EXIT_ALERT` | `zoneEvent` salida | `PENDING` | `currentPointId` pasa a `completedPointIds`; se relee el plan con `forceFresh`; el siguiente es el primer punto no cumplido; si no hay, el paso de reset con `closing = ROUTE_DONE`; `stepSeq + 1`, `transmissionSeq = 0`, `retryCount = 0`, `lastAcceptedCommand = null` |
| 8 | cualquiera excepto `COMPLETED` | la asignación deja de ser vigente | `PENDING` (paso de reset) | si hubo transmisión: `closing = ASSIGNMENT_ENDED` con el estado final, `stepSeq + 1`, `transmissionSeq = 0`, `retryCount = 0`, `pendingRequest = null`, `lastAcceptedCommand = null`, se cancelan temporizadores; si no hubo ninguna, se elimina el estado |
| 9 | `AWAITING_ACK` o `CONFIGURING` (paso de reset) | `ack` del reset | `COMPLETED` si `closing = ROUTE_DONE`; se elimina el estado si `ASSIGNMENT_ENDED` | |
| 10 | `COMPLETED` | la asignación deja de ser vigente | (se elimina) | se registra el estado final |
| 11 | cualquiera | evento que no corresponde (ACK con otro serial, duplicado, entrada repetida, `geofenceId` distinto de 0) | sin cambio | se ignora; log `debug` |

- “Hubo transmisión” ⇔ `stepSeq >= 1` o `transmissionSeq >= 1`.
- La salida se acepta desde `IN_ZONE` aunque no se haya visto la entrada.
- `COMPLETED` se conserva mientras la asignación siga vigente, para no reiniciar la ruta.
- Cada transición se persiste en `RouteState` **antes** del siguiente efecto (llamada a la API, programación).
- Si al releer el plan (fila 7) falla `getPlan`, la salida **no se consume**: ver "Lectura de tramas".

## Concurrencia
Todo lo que toca el estado de una misma asignación (tramas, temporizadores, cierre, transmisión) se ejecuta de uno en uno (exclusión por `assignmentId` dentro del proceso). Asignaciones distintas avanzan en paralelo.

## Transmisión por la API (filas 2 y 5)
1. Se arma el comando (003) y se construye la petición con la clave `{assignmentId}-{stepSeq}-{transmissionSeq}`.
2. Se guarda `pendingRequest` (clave y JSON) en el estado.
3. Se llama a `CommandGateway.send`. Resultados:

| Resultado del gateway | Acción |
|---|---|
| `ACCEPTED` (`SENT_UNCONFIRMED`, `OUTCOME_UNKNOWN` u otro) | Fila 3. `OUTCOME_UNKNOWN` además genera una alerta de auditoría; el ACK decide. |
| `DRY_RUN` | Fila 3 sin retransmisiones mientras dure el modo sombra. |
| `UNCERTAIN` o `UNAVAILABLE` (503) | Sigue en `CONFIGURING`. Se **repite la misma petición** (misma clave y mismo JSON) con `API_RETRY`: 1 s, duplicando hasta 60 s. Sin límite; aviso desde el 3.er intento. |
| `DEFINITIVE_ERROR` (401, 403, 404, 409, 422, 3xx…) | Sigue en `CONFIGURING`. Alerta de error. Se repite la misma petición cada 5 min. Nunca clave nueva. |

- Nunca se crea una clave nueva para reintentar una petición de resultado incierto.
- Si llega el ACK del paso mientras se repite la petición (fila 4), se deja de repetir.
- Si el gateway lanza `AuditUnavailableError`, la transmisión se pospone con alerta y se reintenta con el mismo esquema de `API_RETRY`.
- Cualquier otro error inesperado del gateway se registra y se trata como `UNCERTAIN`.

## Retransmisión por falta de ACK (fila 5)
- Política validada por Ever y Gustavo: `AT+GTGEO` es configuración idempotente.
- Se retransmite solo si la ventana (`ackRetryBackoffMs`) venció sin ACK, con **clave nueva** y el mismo comando y serial.
- La retransmisión usa `lastAcceptedCommand`. Si un estado antiguo no lo tiene, se reconstruye desde el plan y se emite una alerta.
- Cada `ackMaxRetries` retransmisiones sin ACK se emite un aviso de lote agotado (con `assignmentId`, `deviceId`, paso y número de lote) y los lotes continúan indefinidamente.
- Con `opts.dryRun = true` no se programa `ACK_DEADLINE`, no se retransmite y no se emiten avisos de lote. Con `opts.dryRun = false` se aplica la política normal.
- Con `ackResendEnabled = false` no se retransmite: solo se emite el aviso de cada ventana vencida y se programa la siguiente ventana.
- Antes de cada retransmisión se verifica que el paso siga en `AWAITING_ACK` con el mismo `stepSeq` y `transmissionSeq`, y que la asignación siga vigente.

## Cierre por asignación no vigente (fila 8)
- Cada ciclo de asignaciones consulta `listVigentes` por empresa habilitada. Una asignación con estado propio que **no aparece** se consulta con `getById`.
- Si `isActiveAssignment` da falso (estado fuera de {3, 4}, `bol_enuso` falso) o no existe, se cierra según la fila 8 o 10 y se registra el `finalEstado`.
- El reset sigue el mismo ciclo de transmisión, ACK y retransmisión que cualquier paso. Si `closing = ASSIGNMENT_ENDED`, la comprobación de vigencia previa a `ACK_DEADLINE` no impide retransmitir ese reset.

## Lectura de tramas
- Solo se consultan equipos con `RouteState` en `CONFIGURING` (con `pendingRequest`), `AWAITING_ACK`, `IN_ZONE` o `AWAITING_EXIT_ALERT`.
- Un solo poller, **secuencial por equipo**: recorre los equipos en espera uno por uno y espera `pollIntervalMsAck` antes del siguiente recorrido. Si `hasMore`, lee otra vez enseguida (máximo 5 veces por equipo y recorrido, con una pausa corta de 100 ms).
- Cada trama: `decodeFrame` → `parseMessage` (003), en orden de `receivedAt`. `unknown` se ignora. Un `ack` se compara con el serial del paso; un `zoneEvent` solo cuenta si `geofenceId = 0` (zona de las rutas con orden).
- **El cursor se guarda solo después de aplicar con éxito todas las tramas del lote.** Si aplicar una falla (p. ej. `getPlan` en la fila 7), el cursor no avanza y el lote se reaplica en el siguiente recorrido; como las transiciones dependen del estado, lo ya aplicado se ignora (fila 11) y lo pendiente se completa.
- Las alertas del lector las conecta el arranque (spec 006).
- Métricas por recorrido: equipos consultados, filas leídas, duración y rezago (ahora − `receivedAt` de la última trama).

## Polling de asignaciones
- Una consulta `listVigentes` por empresa habilitada cada `pollIntervalMsRoutes`.
- Cada asignación se procesa en su propio `try/catch`, incluida su selección e inicio o su recuperación/cierre. Si falla, se registra `assignment_failed` (`error`) con `assignmentId`, `companyId` y la causa de `describeError`; el ciclo sigue con las demás. `assignment_poll` incluye `failedAssignments`, cantidad de asignaciones distintas que fallaron; un error de consulta sin asignación identificable no se cuenta ahí.
- Espaciado adaptativo: con novedad (asignación nueva, estado cambiado) vuelve al intervalo base; sin novedad el retraso se duplica hasta 5×. Un error se registra, aplica el mismo espaciado y el ciclo siguiente se programa siempre.
- Es independiente de los reintentos de ACK y no cancela ni falla nada.

## Causas de error en logs
`poll_failed`, `assignment_poll_failed`, `chain_poll_failed`, `route_resume_failed` y `assignment_failed` registran `errorName`, `errorCode` si existe y `errorMessage` desde `describeError`. Los eventos especializados de inicio y cierre conservan su nombre y también registran la causa. Nunca se registra el objeto de error crudo.

## Arranque y reinicio
`start()` lee todos los `RouteState` (`list()`), reconstruye el índice `unitId → assignmentId` y retoma cada ruta:
- `PENDING`: se retoma el paso.
- `CONFIGURING` con `pendingRequest`: se **repite la misma petición** (misma clave y JSON).
- `AWAITING_ACK`: con `opts.dryRun = false`, se programa `ACK_DEADLINE` según `ackDeadline`; si ya venció, retransmite. Con `opts.dryRun = true`, no se programa ni se retransmite.
- En un estado anterior sin `lastAcceptedCommand`, se interpreta como `null`; si vence el ACK se reconstruye el comando desde el plan con alerta.
- `IN_ZONE` y `AWAITING_EXIT_ALERT`: siguen leyendo tramas con su cursor guardado (sin cursor, `initCursor`).
- `COMPLETED`: sin acción.
- Los cursores guardados permiten procesar lo ocurrido mientras el proceso estuvo detenido. No existe drenaje de historial.
- Hay una sola cadena de temporizadores por asignación, paso y transmisión (`jobId` determinista); tras un reinicio no se duplican.
- `stop()` detiene los pollers, espera lo que esté en curso y cierra el `Scheduler`.

## Trazabilidad
- Cada transición y cada comando: `timestamp`, `deviceId` y `routeId` (= `assignmentId`).
- Cada lote agotado y cada alerta: además `stepSeq` y `transmissionSeq`.
- Cada ciclo de polling: fuente, resultados y próximo retraso.
- La auditoría de comandos la escribe el gateway (spec 007).

## Criterios de aceptación
- [ ] No se inicia una asignación en estado 1, 2, 5, 6, 7, −1 o 0, con `bol_enuso = false`, de otra empresa o con unidad ya en curso.
- [ ] Una asignación en estado 3 y otra en estado 4, ambas con `horaFinal` nula, inician su ruta.
- [ ] El valor de `horaFinal` (nulo, pasado o futuro) no cambia la decisión de inicio: solo cuentan `enUso` y el estado.
- [ ] Con dos asignaciones vigentes, si la primera lanza un error inesperado, la segunda inicia y se registra `assignment_failed` con el `assignmentId` de la primera; `assignment_poll.failedAssignments` cuenta una.
- [ ] `describeError` redacta `postgres://u:<valor>@host/db` como `postgres://***@host/db` y trunca el resultado a 200 caracteres.
- [ ] `poll_failed` registra `errorName`, `errorCode` si existe y `errorMessage` sin credenciales.
- [ ] Una asignación de ruta tipo 1 no crea estado y emite una sola alerta mientras siga vigente.
- [ ] Una ruta de 2 puntos con fakes pasa en orden por transmisión, ACK, entrada, salida, siguiente punto, reset, ACK del reset y `COMPLETED`.
- [ ] Un ACK con serial de otro paso, un duplicado o un `zoneEvent` con `geofenceId` distinto de 0 se ignoran.
- [ ] Sin ACK: tras cada ventana se retransmite con **clave nueva**; cada `ackMaxRetries` hay un aviso de lote; nunca aparece un estado de fallo ni se salta el punto.
- [ ] Con `ackResendEnabled = false` no se retransmite.
- [ ] Error de red o 503: se repite **la misma clave y el mismo JSON**; un ACK intermedio detiene la repetición.
- [ ] `DEFINITIVE_ERROR` no genera clave nueva y reintenta cada 5 min con alerta.
- [ ] `AuditUnavailableError` pospone la transmisión con alerta y no la pierde.
- [ ] Reinicio con `pendingRequest`: se repite la misma clave; no hay doble transmisión en el gateway.
- [ ] Reinicio en `AWAITING_ACK`: se respeta `ackDeadline` y no se duplican temporizadores.
- [ ] Si se elimina o agrega un punto entre pasos, el siguiente punto es el primero no cumplido del plan nuevo; no se repite ni se salta ninguno.
- [ ] Si `getPlan` falla al procesar una salida, el cursor no avanza y, al recuperarse, la salida se aplica una sola vez.
- [ ] La asignación que pasa a 2, 5, 6 o 7, o que queda con `bol_enuso = false`, cierra con reset si hubo transmisiones, o solo se elimina si no las hubo; el estado final queda registrado.
- [ ] Una asignación en estado 3 inicia la ruta; una que aparece directamente en estado 4 también.
- [ ] Una asignación en estado 1 no crea `RouteState`, no consulta tramas ni transmite.
- [ ] Una ruta en curso cuya asignación pasa de 3 a 4 conserva su `RouteState`, su `stepSeq` y sus temporizadores: no hay reset ni segundo hilo.
- [ ] El reset de cierre por asignación no vigente se retransmite si falta su ACK, aunque `isActiveAssignment` sea falso.
- [ ] Un equipo que nunca responde no bloquea a otro; dos eventos de la misma asignación no se procesan en paralelo.
- [ ] Una salida se acepta desde `IN_ZONE` sin entrada previa.
- [ ] El polling de tramas solo consulta equipos en espera, uno por uno, y se pone al día con `hasMore`.
- [ ] Con `opts.dryRun = true` (mismo `COMMAND_DRY_RUN` que recibe el gateway desde 006) se llega a `AWAITING_ACK` sin temporizador, retransmisión ni avisos de lote, también tras reiniciar. Con `opts.dryRun = false` se retransmite según la política normal.
- [ ] La lógica de transición es testeable sin BullMQ, Redis ni red (principio III).
- [ ] Las pruebas usan fakes de 001, 005 y 007, el `Scheduler` falso con tiempo controlado, los módulos reales de 003 y Redis en memoria; no hay BD local.

## Fuera de alcance (limitaciones conocidas de la v1)
- Rutas desordenadas (`int_tipo = 1`) → spec 009.
- Cambios al punto **actual** mientras se espera su salida (se aplican al siguiente paso).
- Cambio de unidad o de dispositivo durante la ruta.
- Más de una instancia del middleware.
- Herramientas manuales de intervención.

## Supuestos y riesgos
- `State Mode 0` puede reportar una salida inmediata si el equipo se configura fuera de la zona. Validar en la fase de pruebas con unidad real; si ocurre, se corrige en la spec 003.
- Una salida duplicada o tardía del punto anterior podría completar el siguiente (ver `docs/architecture.md` §10).
- El adaptador de BullMQ no se puede probar con Redis en memoria (usa scripts Lua): se verifica en el despliegue sombra y de pruebas.

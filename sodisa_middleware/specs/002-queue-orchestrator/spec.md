# Spec 002 — Orquestador (FSM por asignación)

> Carpeta `specs/002-queue-orchestrator`; código en `src/orchestrator/`.

## Objetivo
Avanzar cada asignación vigente: iniciarla cuando corresponda, configurar el punto actual en el equipo
(vía la API de comandos), confirmar su ACK, detectar la entrada y la salida de zona, pasar al siguiente punto y
cerrar la ruta desactivando la zona y apagando la salida 2.

## Principio rector
Este middleware corre sin interfaz ni operador. Por eso:
- **Nunca se rinde:** un comando sin ACK se retransmite indefinidamente. No existe estado `FAILED` ni pausa para operador.
- **Nunca salta un punto:** avanza solo tras el ACK, la entrada y la salida de zona del punto actual.
- **Nunca se detiene por un error:** un fallo en un equipo, en la API o en una consulta se registra y no afecta a otros equipos ni al siguiente ciclo.

## Módulos que usa
001 (asignaciones y tramas), 003 (comandos y lectura de tramas), 004 (estado), 005 (unidad y plan), 007 (API y auditoría), y `src/common/` (descripción segura de errores). Solo a través de sus `index.ts`.

## Interfaces
```typescript
interface Logger { debug|info|warn|error(event: string, fields?: Record<string, unknown>): void }

interface OrchestratorOptions {
  enabledCompanies: Map<number, number>;   // plataforma -> companyId de la API (ENABLED_COMPANIES)
  pollIntervalMsRoutes: number;            // POLL_INTERVAL_MS_ROUTES
  chainPollIntervalMs: number;             // CHAIN_POLL_INTERVAL_MS
  chainMaxQueriesPerSecond: number;        // CHAIN_MAX_QUERIES_PER_SECOND
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
  chainQueryLimiter: ChainQueryLimiter;    // compartido con el SqlClient de tramas en 006
}
interface Orchestrator { start(): Promise<void>; stop(): Promise<void>; }
function createOrchestrator(deps: OrchestratorDeps, opts: OrchestratorOptions): Orchestrator;
interface ChainQueryStats {
  queries: number; rows: number; avgDurationMs: number; maxDurationMs: number; throttledMs: number;
}
interface ChainQueryLimiter {
  run<T extends { rows: unknown[] }>(query: () => Promise<T>): Promise<T>;
  takeStats(): ChainQueryStats;
  minimumSpacingMs(): number;
  close(): Promise<void>;
}
function createChainQueryLimiter(maxQueriesPerSecond: number, now?: () => number): ChainQueryLimiter;

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
- Una asignación vigente por unidad. Se excluyen las asignaciones `COMPLETED` antes de ordenar las candidatas por `horaInicial` y `assignmentId`. El índice `unitId → assignmentId` contiene solo rutas activas y se reconstruye con esas rutas al arrancar. Se registra `assignment_skipped_completed` (`info`, con `routeId` y `unitId`) una vez por vigencia y `unit_already_in_route` (`warn`, con `routeId`, `unitId` y `occupyingRouteId`) una vez por par candidata–ocupante. `assignment_poll` incluye hasta 20 `candidateIds`.
- **Al iniciar** (en este orden): `resolveForRouteStart` (005) → `getPlan` con `forceFresh` (005) → si `routeType = 1`: alerta `ROUTE_TYPE_UNORDERED_SKIPPED` (una vez por asignación mientras siga vigente, sin persistir) y **no se crea estado** → `initCursor` (001) y guardarlo → crear el `RouteState` (`PENDING`, `stepSeq = 0`, `currentPointId` = primer punto, `routeType = 0`). Si algo falla (modelo desconocido, plan inválido, unidad inválida), se registra la alerta, **no se crea estado** y se reintenta en el siguiente ciclo.
- El cursor del equipo se inicializa **antes** de la primera transmisión, para ignorar tramas anteriores.

## Estados
| Estado | Significado |
|---|---|
| `PENDING` | El paso actual aún no se ha transmitido. |
| `CONFIGURING` | Se está transmitiendo el comando del paso actual a la API. |
| `AWAITING_ACK` | La API aceptó la transmisión; se espera el ACK del equipo. |
| `AWAITING_ENTER_ALERT` | ACK recibido; zona activa; se espera la entrada. Una salida en este estado se ignora. |
| `AWAITING_EXIT_ALERT` | Entrada registrada; se espera la salida. |
| `COMPLETED` | Ruta terminada, zona desactivada y salida 2 apagada; ACK del reset y de `GTOUT` recibidos. |

Un **paso** es un punto de la ruta, el reset (`currentPointId = null`, `closingPhase = RESET`) o el apagado de salida 2 (`closingPhase = OUT_OFF`).
`stepSeq` cuenta los pasos (empieza en 0) y su hexadecimal en mayúsculas de 4 dígitos es el **serial** del comando. Todas las transmisiones de un mismo paso usan el mismo serial.
Comandos: punto → `buildGeoCommand` con modo 3 (entra y sale), zona 0 y los datos del punto; reset → `buildResetCommand`; apagado → `buildOutOffCommand` (003).

## Transiciones
| # | Estado | Evento | Estado nuevo | Efecto |
|---|---|---|---|---|
| 1 | (sin estado) | asignación elegible | `PENDING` | ver "Al iniciar" |
| 2 | `PENDING` | paso listo | `CONFIGURING` | se arma el comando (003), `transmissionSeq = 1`, se guarda `pendingRequest` con clave nueva y, antes de invocar al gateway por primera vez en el paso, `firstTransmissionAt` |
| 3 | `CONFIGURING` | gateway `ACCEPTED` o `DRY_RUN` | `AWAITING_ACK` | se guarda `lastAcceptedCommand` con el comando del paso y se limpia `pendingRequest`; con `opts.dryRun = false`, `ackDeadline = ahora + ackRetryBackoffMs` y se programa `ACK_DEADLINE`; con `opts.dryRun = true`, `ackDeadline = null` y no se programa |
| 4 | `CONFIGURING` (con `pendingRequest`) o `AWAITING_ACK` | `ack` `GTGEO` con el serial del punto | `AWAITING_ENTER_ALERT` | se descartan `pendingRequest` y `lastAcceptedCommand`; se cancelan temporizadores del paso |
| 5 | `AWAITING_ACK` | `ackDeadline` vencido sin ACK y lectura exitosa posterior al mínimo, o salvaguarda vencida sin tal lectura | `CONFIGURING` | `transmissionSeq + 1`, `retryCount + 1`, clave nueva (ver "Retransmisión") |
| 6 | `AWAITING_ENTER_ALERT` | `zoneEvent` entrada | `AWAITING_EXIT_ALERT` | se registra la entrada |
| 7 | `AWAITING_EXIT_ALERT` | `zoneEvent` salida | `PENDING` | `currentPointId` pasa a `completedPointIds`; se relee el plan con `forceFresh`; el siguiente es el primer punto no cumplido; si no hay, el paso de reset con `closing = ROUTE_DONE`; `stepSeq + 1`, `transmissionSeq = 0`, `retryCount = 0`, `lastAcceptedCommand = null`, `firstTransmissionAt = null` |
| 8 | cualquiera excepto `COMPLETED` | la asignación deja de ser vigente | `PENDING` (paso de reset) | si hubo transmisión y aún no cierra: `closing = ASSIGNMENT_ENDED`, `closingPhase = RESET`, `stepSeq + 1` y contadores del paso en cero; si no hubo transmisión se elimina. Si ya cierra, conserva la fase alcanzada. |
| 9 | `AWAITING_ACK` o `CONFIGURING` (paso de reset) | `ack` `GTGEO` del reset | `PENDING` (paso `OUT_OFF`) | `stepSeq + 1`, contadores del paso en cero; se transmite `GTOUT` con el serial siguiente. |
| 9a | `AWAITING_ACK` o `CONFIGURING` (paso `OUT_OFF`) | `ack` `GTOUT` coincidente | `COMPLETED` si `closing = ROUTE_DONE`; se elimina el estado si `ASSIGNMENT_ENDED` | se libera la unidad solo después de este ACK. |
| 10 | `COMPLETED` | la asignación deja de ser vigente | (se elimina) | se registra el estado final |
| 11 | cualquiera | evento que no corresponde (ACK con otro serial, duplicado, entrada repetida, `geofenceId` distinto de 0) | sin cambio | se ignora; log `debug` |
| 12 | `AWAITING_ENTER_ALERT` | `zoneEvent` salida (sin entrada previa en el paso) | sin cambio | se ignora; log `exit_before_enter_ignored` (nivel `info`) con `deviceId`, `routeId` y `stepSeq` |

- “Hubo transmisión” ⇔ `stepSeq >= 1` o `transmissionSeq >= 1`.
- La salida solo se acepta desde `AWAITING_EXIT_ALERT`, es decir, después de una entrada registrada en el mismo paso. Una salida recibida en `AWAITING_ENTER_ALERT` se ignora (fila 12). Una entrada recibida en `AWAITING_ACK` se ignora (fila 11): puede pertenecer a la configuración anterior del equipo.
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
- `ackDeadline` es la hora mínima para retransmitir, fijada al aceptar cada transmisión. No se desplaza si no hubo una nueva transmisión. Tras aplicar un lote completo y guardar su cursor, se relee el estado: si sigue el mismo paso y transmisión en `AWAITING_ACK`, venció el mínimo y la asignación sigue vigente o está cerrando, se retransmite con **clave nueva** y el mismo comando y serial. Un ACK del lote impide la retransmisión.
- `ACK_DEADLINE` comprueba el estado al llegar el mínimo y programa una salvaguarda para `lastAcceptedAt + 2 × chainPollIntervalMs` (nunca antes del mínimo). Si no hubo lectura exitosa posterior al mínimo que pudiera decidir, la salvaguarda retransmite. Una lectura anterior al mínimo no la desactiva. Los trabajos obsoletos no actúan.
- La retransmisión usa `lastAcceptedCommand`. Si un estado antiguo no lo tiene, se reconstruye desde el plan y se emite una alerta.
- Cada `ackMaxRetries` retransmisiones sin ACK se emite un aviso de lote agotado (con `assignmentId`, `deviceId`, paso y número de lote) y los lotes continúan indefinidamente.
- Con `opts.dryRun = true` no se programa `ACK_DEADLINE`, no se retransmite y no se emiten avisos de lote. Con `opts.dryRun = false` se aplica la política normal.
- Con `ackResendEnabled = false` no se retransmite: solo se emite el aviso de cada ventana vencida y se programa el siguiente aviso.
- Antes de cada retransmisión se verifica que el paso siga en `AWAITING_ACK` con el mismo `stepSeq` y `transmissionSeq`, y que la asignación siga vigente o esté cerrando.

## Cierre por asignación no vigente (fila 8)
- Cada ciclo de asignaciones consulta `listVigentes` por empresa habilitada. Una asignación con estado propio que **no aparece** se consulta con `getById`.
- Si `isActiveAssignment` da falso (estado fuera de {3, 4}, `bol_enuso` falso) o no existe, se cierra según la fila 8 o 10 y se registra el `finalEstado`.
- Reset y `GTOUT` siguen el mismo ciclo de transmisión, ACK y retransmisión que cualquier paso. Si `closing = ASSIGNMENT_ENDED`, se completa la fase alcanzada aunque la asignación ya no sea vigente.

## Lectura de tramas
- Solo se consultan equipos con `RouteState` en `CONFIGURING` (con `pendingRequest`), `AWAITING_ACK`, `AWAITING_ENTER_ALERT` o `AWAITING_EXIT_ALERT`.
- Cada equipo en espera tiene `nextPollAt`: el primero es inmediato y, tras una lectura, pasa a `ahora + chainPollIntervalMs`. Se atiende el vencido más antiguo. El poller reparte los turnos durante el intervalo objetivo y usa un solo lector en vuelo.
- Toda consulta SQL a una partición de `tbl_cadena`, tanto de `initCursor` como de `readNew`, pasa por el mismo `ChainQueryLimiter` conectado al `SqlClient` por 006. Entre consultas hay al menos `1000 / chainMaxQueriesPerSecond` ms y, para tasas ≥ 1, ninguna ventana móvil de 1 s supera `floor(chainMaxQueriesPerSecond)` consultas. Para tasas menores de 1, se hace una consulta cada `1 / tasa` segundos como máximo. Solo hay una consulta en vuelo. Las consultas al catálogo de particiones quedan fuera del tope.
- Si `hasMore`, el equipo vuelve vencido a la cola y usa el siguiente turno disponible del limitador, sin lecturas inmediatas repetidas ni máximo de cinco lotes; los demás equipos vencidos conservan prioridad por `nextPollAt`. El reparto del intervalo objetivo se aplica cuando no hay lotes pendientes. Si la demanda supera el tope, crece `effectiveIntervalMs` y se emite `chain_poll_saturated` (`warn`) a lo más una vez por minuto, con `devices` y `effectiveIntervalMs`.
- Tras cada consulta SQL fallida consecutiva, el espaciado mínimo se duplica hasta 10 s; una consulta exitosa lo restaura. Se conserva `chain_poll_failed`. El sondeo de asignaciones no pasa por el limitador ni espera sus turnos: las inicializaciones de cursor pendientes se ejecutan aparte, el primer sondeo de tramas tampoco bloquea el ciclo de asignaciones y se revalida la vigencia antes de transmitir.
- Cada trama: `decodeFrame` → `parseMessage` (003), en orden de `receivedAt`. `unknown` se ignora. Un `ack` se compara con el tipo de comando y serial del paso; un `zoneEvent` solo cuenta si `geofenceId = 0` (zona de las rutas con orden).
- **El cursor se guarda solo después de aplicar con éxito todas las tramas del lote.** Si aplicar una falla (p. ej. `getPlan` en la fila 7), el cursor no avanza y el lote se reaplica en el siguiente recorrido; como las transiciones dependen del estado, lo ya aplicado se ignora (fila 11) y lo pendiente se completa.
- Las alertas del lector las conecta el arranque (spec 006).
- La partición de `tbl_cadena` es única para todo el servicio (spec 001); `chain_partition_selected` registra su elección. La lectura de la partición anterior durante el corte semanal usa la misma cola y el mismo limitador, y cada consulta cuenta en `chain_poll_summary.queries`.
- Un cursor heredado con `cursor.partition > weekLabel(ahora)` se repara antes de leer. El ancla es `firstTransmissionAt` del paso; si falta y está en `AWAITING_ACK`, se usa `ackDeadline − ackRetryBackoffMs`; `startedAt` se admite solo para `stepSeq = 0`. Con ancla válida se reancla la lectura a su semana (si está en el catálogo) y se registra `chain_cursor_reset` con `anchor: 'transmission'`. Sin ancla utilizable se llama a `initCursor` en la partición calculada, no se entregan tramas en ese turno y se registra `anchor: 'init'`. Nunca se usa `startedAt` en pasos posteriores. El cursor corregido se persiste solo después de aplicar con éxito el lote.
- No se registra `chain_poll` por consulta. Cada minuto se registra `chain_poll_summary` (`info`) con `devices`, `queries`, `rows`, `avgDurationMs`, `maxDurationMs`, `maxLagMs`, `throttledMs` y `effectiveIntervalMs`. `queries` cuenta intentos SQL a particiones; `rows` cuenta sus filas devueltas. `maxLagMs` es el mayor rezago de las tramas procesadas, o `null` si no hubo tramas.

## Polling de asignaciones
- Una consulta `listVigentes` por empresa habilitada cada `pollIntervalMsRoutes`.
- Cada asignación se procesa en su propio `try/catch`, incluida su selección e inicio o su recuperación/cierre. Si falla, se registra `assignment_failed` (`error`) con `assignmentId`, `companyId` y la causa de `describeError`; el ciclo sigue con las demás. `assignment_poll` incluye `failedAssignments`, cantidad de asignaciones distintas que fallaron; un error de consulta sin asignación identificable no se cuenta ahí.
- Si falla una inicialización de cursor que quedó pendiente tras terminar el ciclo, se registra `assignment_failed` al ocurrir y se cuenta en `failedAssignments` del siguiente ciclo.
- Espaciado adaptativo: con novedad (asignación nueva, estado cambiado) vuelve al intervalo base; sin novedad el retraso se duplica hasta 5×. Un error se registra, aplica el mismo espaciado y el ciclo siguiente se programa siempre.
- Es independiente de los reintentos de ACK y no cancela ni falla nada.

## Causas de error en logs
`poll_failed`, `assignment_poll_failed`, `chain_poll_failed`, `route_resume_failed` y `assignment_failed` registran `errorName`, `errorCode` si existe y `errorMessage` desde `describeError`. Los eventos especializados de inicio y cierre conservan su nombre y también registran la causa. Nunca se registra el objeto de error crudo.

## Arranque y reinicio
`start()` lee todos los `RouteState` (`list()`), reconstruye el índice `unitId → assignmentId` solo de rutas no completadas y retoma cada ruta:
- `PENDING`: se retoma el paso.
- `CONFIGURING` con `pendingRequest`: se **repite la misma petición** (misma clave y JSON).
- `AWAITING_ACK`: con `opts.dryRun = false`, se respeta `ackDeadline` y se programa la salvaguarda; una lectura posterior al mínimo decide primero. Con `opts.dryRun = true`, no se programa ni se retransmite.
- En un estado anterior sin `lastAcceptedCommand`, se interpreta como `null`; si vence el ACK se reconstruye el comando desde el plan con alerta.
- `AWAITING_ENTER_ALERT` y `AWAITING_EXIT_ALERT`: siguen leyendo tramas con su cursor guardado (sin cursor, `initCursor`).
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
- [ ] Una ruta de 2 puntos con fakes pasa en orden por transmisión, ACK, entrada, salida, siguiente punto, reset, ACK del reset, `GTOUT`, ACK de `GTOUT` y `COMPLETED`.
- [ ] Un ACK con serial de otro paso, un duplicado o un `zoneEvent` con `geofenceId` distinto de 0 se ignoran.
- [ ] Sin ACK: tras el mínimo y una lectura exitosa, o al vencer la salvaguarda sin esa lectura, se retransmite con **clave nueva**; cada `ackMaxRetries` hay un aviso de lote; nunca aparece un estado de fallo ni se salta el punto.
- [ ] Con `ackResendEnabled = false` no se retransmite.
- [ ] Error de red o 503: se repite **la misma clave y el mismo JSON**; un ACK intermedio detiene la repetición.
- [ ] `DEFINITIVE_ERROR` no genera clave nueva y reintenta cada 5 min con alerta.
- [ ] `AuditUnavailableError` pospone la transmisión con alerta y no la pierde.
- [ ] Reinicio con `pendingRequest`: se repite la misma clave; no hay doble transmisión en el gateway.
- [ ] Reinicio en `AWAITING_ACK`: se respeta `ackDeadline` y no se duplican temporizadores.
- [ ] Si se elimina o agrega un punto entre pasos, el siguiente punto es el primero no cumplido del plan nuevo; no se repite ni se salta ninguno.
- [ ] Si `getPlan` falla al procesar una salida, el cursor no avanza y, al recuperarse, la salida se aplica una sola vez.
- [ ] La asignación que pasa a 2, 5, 6 o 7, o que queda con `bol_enuso = false`, cierra con reset y `GTOUT` si hubo transmisiones, o solo se elimina si no las hubo; el estado final queda registrado.
- [ ] Una asignación en estado 3 inicia la ruta; una que aparece directamente en estado 4 también.
- [ ] Una asignación en estado 1 no crea `RouteState`, no consulta tramas ni transmite.
- [ ] Una ruta en curso cuya asignación pasa de 3 a 4 conserva su `RouteState`, su `stepSeq` y sus temporizadores: no hay reset ni segundo hilo.
- [ ] El reset de cierre por asignación no vigente se retransmite si falta su ACK, aunque `isActiveAssignment` sea falso.
- [ ] Un equipo que nunca responde no bloquea a otro; dos eventos de la misma asignación no se procesan en paralelo.
- [ ] Una salida en `AWAITING_ENTER_ALERT` conserva el estado y el paso, no relee el plan y registra `exit_before_enter_ignored` con `deviceId`, `routeId` y `stepSeq`.
- [ ] ACK → salida → entrada → salida: solo la segunda salida avanza; el resultado es igual si las cuatro tramas llegan en un mismo lote.
- [ ] Una entrada en `AWAITING_ACK` no habilita la salida; una entrada repetida en `AWAITING_EXIT_ALERT` se ignora.
- [ ] El ACK del reset inicia el paso `GTOUT`; solo su ACK correcto completa la ruta sin entrada ni salida previas.
- [ ] Si A está `COMPLETED`, B de la misma unidad puede comenzar; borrar A conserva el índice y cursor de B. Los avisos de completada y unidad ocupada no se repiten cada ciclo.
- [ ] `assignment_skipped_completed` incluye `routeId` y `unitId`; `unit_already_in_route` incluye `routeId`, `unitId` y `occupyingRouteId`, con pruebas que comparan los valores.
- [ ] En el paso de apagado, los ACK `GTOUT` reales de reglas del equipo con seriales `01F8` y `002E` se ignoran si el serial del paso es `0A05`; el ACK real `0A05` completa el cierre.
- [ ] Con las tramas reales de la ruta 2035162, el paso 0 avanza tras entrada y salida; las salidas de 16:36:54 y 16:37:53 en el paso 1 se ignoran y no se transmite el paso 2 ni el reset.
- [ ] Una ruta reanudada en `AWAITING_ENTER_ALERT` exige una entrada antes de aceptar la salida.
- [ ] El polling de tramas solo consulta equipos en espera, sin rebasar el tope por segundo, y se pone al día con `hasMore` sin ráfagas.
- [ ] Con 60 equipos e intervalo de 60 s, en 10 minutos cada uno se consulta 10 veces (±1); ninguna ventana móvil de 1 s supera el tope.
- [ ] Con 200 equipos y tope de 3/s, crece el intervalo efectivo y `chain_poll_saturated` se emite a lo más una vez por minuto.
- [ ] Treinta rutas simultáneas limitan todas las consultas SQL de `initCursor`, incluso cuando cada llamada hace dos; `readNew` con cambio de partición y `hasMore` respeta el mismo tope.
- [ ] Tras fallos consecutivos el espaciado se duplica hasta 10 s y vuelve al normal tras un éxito; un equipo nuevo tiene turno inmediato y el sondeo de asignaciones avanza mientras la cola está saturada.
- [ ] `chain_poll_summary` aparece una vez por minuto con todos sus campos y no existe `chain_poll` por consulta.
- [ ] En la ventana doble las consultas adicionales pasan por `ChainQueryLimiter` y se cuentan en `chain_poll_summary.queries` sin rebasar `chainMaxQueriesPerSecond`.
- [ ] Un cursor futuro heredado usa primero `firstTransmissionAt`, luego `ackDeadline − ackRetryBackoffMs` en `AWAITING_ACK`, y `startedAt` solo en el paso 0; sin ancla utilizable usa `initCursor`, entrega cero tramas en el turno y registra `chain_cursor_reset` con `anchor: 'init'`.
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
- Confirmado en la prueba física del 2026-11-25: un equipo configurado fuera de la zona reporta una salida (`00`) a los pocos segundos del ACK sin haber entrado. Se resuelve con la regla de entrada previa (filas 7 y 12). Limitación: si el equipo está dentro de la zona al configurarse y sale antes de reportar su entrada, la ruta espera una nueva entrada.
- Una salida duplicada o tardía del punto anterior podría completar el siguiente (ver `docs/architecture.md` §10).
- El adaptador de BullMQ no se puede probar con Redis en memoria (usa scripts Lua): se verifica en el despliegue sombra y de pruebas.

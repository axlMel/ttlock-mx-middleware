# Plan — 002-queue-orchestrator

## Estructura de archivos
```
src/orchestrator/
  types.ts           // DomainEvent (reutiliza RouteState de 004)
  fsm.ts             // lógica pura: (estado, evento) → nuevo estado, sin I/O
  worker.ts          // cola, handlers y reintentos: conecta fsm.ts con 001/003/004/005
  fsm.test.ts
  worker.test.ts
```

## Decisiones técnicas
- **`fsm.ts` es una función pura:** `transition(state: RouteState | null, event:
  DomainEvent): RouteState | null`. La asignación detectada crea `PENDING`
  desde `null`. Un evento que no corresponde al estado
  devuelve el mismo estado. Sin BullMQ, Redis ni red (principio III).
- **`worker.ts` es la única pieza con I/O.** Recibe como dependencias
  inyectadas: `RouteDetector` y `ChainReportDetector` (001),
  `DeviceDirectory` (005), `buildGeoCommand`/`parseMessage`/
  `sendGeoCommand` (003), `RouteStateStore` y `PollingCursorStore` (004), y
  una interfaz mínima `JobQueue` sobre BullMQ (`add` con `delay` y
  `jobId`). Esa interfaz permite fakes en los tests.
- **Cola única `site-lifecycle`** con tres tipos de job: `poll-routes`,
  `poll-reports` y `send-command`.
- **Obtención del paso a enviar:** el handler de envío obtiene las filas
  del IMEI con `getActiveRoutes`, las ordena por `order` y toma
  `currentSiteIndex`; si el índice es igual al total, es el paso de reset
  (`mode: 0`). Modelo, IP y puerto salen de `DeviceDirectory`; comando y
  envío, de 003. Si el IMEI ya no aparece en las asignaciones vigentes al
  reenviar, se registra `warn` y se detiene el reenvío de esa cadena
  (cancelaciones: fuera de alcance).
- **Reintentos de ACK por lotes** (BullMQ):
  - Job `send-command` con `attempts = ACK_MAX_RETRIES + 1` (BullMQ cuenta
    el intento inicial) y `backoff` fijo de `ACK_RETRY_BACKOFF_MS`.
  - El primer intento envía desde `PENDING` o `CONFIGURING`; los intentos
    posteriores solo reenvían si el mismo paso sigue en `AWAITING_ACK`.
    Tras el envío se lanza
    `AckPendingError` para que BullMQ programe el siguiente intento.
  - Al agotarse los intentos del lote (evento `failed` con `attemptsMade >=
    attempts`), si el paso sigue esperando: log `warn` y se encola el
    siguiente lote con `delay = ACK_RETRY_BACKOFF_MS`.
  - **Aclaración:** el estado `failed` de un job de BullMQ es un concepto
    interno de la cola. No es un estado de la FSM, no se persiste en
    `RouteState` y nunca detiene la ruta.
  - `retryCount` acumula reenvíos del paso actual y se reinicia al avanzar.
    Una sola cadena de reintentos activa por dispositivo y paso: `jobId`
    determinístico por dispositivo, paso y lote.
  - Limpieza (`removeOnComplete`, `removeOnFail` con tope) para que los
    lotes sucesivos no acumulen jobs en Redis indefinidamente.
- **Polling adaptativo por reencolado:** cada job de polling, al terminar,
  encola el siguiente con `delay` según la spec (base con novedad; el doble
  hasta 5× sin novedad o con error). Para saber si algún equipo espera
  eventos, el worker consulta `RouteStateStore.list()` para encontrar estados
  en `AWAITING_ACK`/`IN_ZONE`/`AWAITING_EXIT_ALERT`, incluso tras reiniciar.
- **Drenaje inicial:** si `PollingCursorStore.get('reporte_cadenas')` es
  `null`, se llama a `getNewEvents` en bucle hasta recibir un lote vacío,
  descartando los eventos, antes del primer `poll-routes`.
- **Reanudación al arrancar:** para cada `RouteState` en `PENDING`,
  `CONFIGURING` o `AWAITING_ACK` se encola el envío de su paso actual,
  verificando que no exista ya una cadena activa (mismo `jobId`).
- **Conciliación:** usar `RouteStateStore.list()` en cada ciclo de rutas para
  eliminar estados `COMPLETED` cuyo IMEI ya no esté vigente.
- **Cursor:** verificar cómo 001 avanza el cursor. Si lo avanza al devolver
  el lote (antes de que 002 aplique los eventos), dejarlo anotado como
  limitación conocida en la spec; no modificar 001 en esta iteración.
- **Dependencias:** añadir `bullmq` a la raíz y actualizar el lockfile. La
  conexión de `ioredis` para BullMQ usa `maxRetriesPerRequest: null`
  (requisito de BullMQ para workers).

## Testing
- `fsm.test.ts`: tabla de casos, una por fila de la tabla de transiciones
  de la spec, más eventos ignorados y salida sin entrada previa. Sin mocks.
- `worker.test.ts`: fakes de 001, 003, 005 y de `JobQueue` (con control
  manual del tiempo); 004 puede usar `ioredis-mock`. Escenarios: los
  criterios de aceptación de la spec (ruta de 2 sitios, varios lotes sin
  ACK, ACK duplicado, aislamiento entre dispositivos, polling adaptativo,
  arranque sin cursor, reinicio, trazas).

## Alternativas descartadas
- **Estado `FAILED` o pausa para operador:** descartado por requisito de
  negocio. El middleware no tiene interfaz; nadie reanudaría una pausa.
- **Librería de FSM (xstate u otra):** la máquina tiene 6 estados y
  transiciones simples (principio I).
- **`repeat: { every }` de BullMQ:** intervalo fijo; no permite el
  espaciado adaptativo.
- **Un poller separado para alertas:** ACKs y alertas salen de la misma
  tabla y el mismo cursor; duplicaría consultas.

# Plan 002 — Orquestador

## Decisiones
1. **Núcleo puro + ejecutor.** Las transiciones son funciones puras (`transition.ts`): reciben estado y evento y devuelven estado nuevo y efectos. El ejecutor hace la E/S (API, Redis, plan) y las aplica. Así toda la tabla de transiciones se prueba sin BullMQ, Redis ni red.
2. **BullMQ solo para temporizadores por paso** (`ACK_DEADLINE`, `API_RETRY`), detrás de la interfaz `Scheduler`. Los dos pollers son bucles propios con retardo (`setTimeout` encadenado), no trabajos de cola: su ritmo es adaptativo y no necesitan persistencia, porque tras un reinicio se reconstruyen desde el `RouteState`.
3. **Los temporizadores no son la fuente de verdad.** Lo es el `RouteState` (`ackDeadline`, `pendingRequest`, `stepSeq`, `transmissionSeq`). Cada tarea, al dispararse, vuelve a verificar el estado antes de actuar; una tarea obsoleta no hace nada.
4. **`jobId` determinista**: `ack:{assignmentId}:{stepSeq}:{transmissionSeq}` y `api:{assignmentId}:{stepSeq}:{transmissionSeq}:{attempt}`. Con `removeOnComplete` y `removeOnFail` para poder reutilizar ids tras un reinicio.
   BullMQ rechaza `:` en ids personalizados: el adaptador traduce los ids lógicos a ids internos compatibles reemplazando `:` por `-`, sin cambiar la interfaz `Scheduler`.
5. **Exclusión por asignación** (`keyedMutex.ts`): cadena de promesas por `assignmentId`. Es suficiente porque la v1 es de una sola instancia.
6. **Cursor tras aplicar.** Se guarda solo cuando todo el lote se aplicó; las transiciones se basan en el estado, así reaplicar es seguro. Evita perder una salida si `getPlan` falla.
7. **Serial** = `stepSeq` en hexadecimal mayúsculas de 4 dígitos (`serial.ts`).
8. **Reloj y `Logger` inyectables**; el orquestador no lee `process.env` (lo hace 006).
9. **Ruta tipo 1:** se omite con alerta única en memoria; no se persiste nada.
10. **Estados de asignación de 001.** `assignmentCycle` y la verificación de retransmisión usan `isActiveAssignment` del índice público de 001 para filas de `getById`; ambos pasos de cierre se retransmiten aun después de perder vigencia. El inicio solo exige vigencia; `horaFinal` es informativa y `START_MARGIN_MINUTES` no existe. Un cambio entre 3 y 4 conserva el estado y los temporizadores.
11. **Aislamiento por asignación.** Capturar fallos dentro de cada candidato antes de pasar al siguiente; los fallos por empresa sin `assignmentId` no aumentan `failedAssignments`. Conservar eventos especializados y registrar también `assignment_failed` para una asignación que no pudo procesarse.
12. **Diagnóstico compartido.** `src/common/errors.ts` expone `describeError` por `src/common/index.ts`, autorizado para 002 y 006. Redactar URLs antes de truncar evita mostrar una contraseña cortada sin el `@` final. No registrar errores crudos.
13. **Cola de tramas por equipo.** `chainPoller` conserva un `nextPollAt` por equipo, atiende primero el vencido más antiguo y reparte los turnos normales con un intervalo objetivo de `chainPollIntervalMs / devices`, sujeto al tope SQL. `hasMore` reencola el equipo para el siguiente turno permitido por el limitador, dando prioridad a los otros equipos vencidos. Al reiniciar reconstruye la cola desde `RouteState`; no persiste tiempos de polling.
14. **Límite SQL compartido.** `createChainQueryLimiter` de 002 se exporta por `index.ts`. 006 lo usa para envolver solo las consultas del `SqlClient` a particiones `tbl_cadena."YYYYWW"`, con una única consulta en vuelo. El límite cubre las múltiples consultas de una misma llamada a 001 sin cambiar su contrato; las consultas de catálogo de particiones y asignaciones quedan fuera. El limitador acumula métricas por minuto y aplica retroceso global tras fallos SQL.
15. **Inicio independiente.** Las inicializaciones de cursor se ejecutan como trabajo pendiente por asignación, con reserva de unidad para evitar duplicados. `assignmentCycle.run()` no espera el turno SQL; el primer sondeo de tramas se inicia sin bloquear el ciclo de asignaciones. Al terminar la espera se vuelve a comprobar la vigencia antes de transmitir. `stop()` cancela esperas pendientes y espera la consulta en vuelo.
16. **Registro agregado.** El poller emite `chain_poll_summary` cada minuto con las métricas del limitador, rezago y equipos; `chain_poll_saturated` se limita a un aviso por minuto. `effectiveIntervalMs` es el máximo entre el objetivo por equipo y el tiempo requerido por la carga al tope configurado.
17. **Partición semanal y cursores futuros.** 001 conserva marcas independientes por partición (004) y usa el limitador compartido. Antes de leer un cursor futuro heredado, el poller lo reancla a la primera transmisión persistida del paso; en estados antiguos `AWAITING_ACK` deriva `ackDeadline − backoff`, o usa `startedAt` solo en paso 0. Sin ancla segura hace `initCursor` y no procesa frames en ese turno; registra `chain_cursor_reset` sin secretos. El cursor se guarda tras aplicar el lote.
18. **Entrada previa obligatoria.** La transición pura conserva `AWAITING_ENTER_ALERT` ante `EXIT` y devuelve un efecto específico de salida prematura. El ejecutor evita `getPlan` para ese evento y registra el efecto a nivel `info`. Solo `AWAITING_EXIT_ALERT` permite consultar el siguiente punto y avanzar. 004 migra el nombre antiguo al leerlo.
19. **Cierre secuencial.** El reset y `GTOUT` (apagado de la salida 2) son pasos distintos con seriales sucesivos. `closingPhase` distingue ambos; ACK de tipo incorrecto o serial ajeno se ignora. Una ruta que ya cierra no vuelve a resetearse al perder vigencia.
20. **Reenvío guiado por lectura.** El poller aplica todo el lote, guarda el cursor y entonces comprueba la identidad del paso y transmisión antes de retransmitir. `ACK_DEADLINE` solo arma la salvaguarda a `lastAcceptedAt + 2 × chainPollIntervalMs`, con `ackDeadline` como mínimo. `lastAcceptedAt` sobrevive reinicios; para JSON anterior se deriva de `ackDeadline − backoff`.
21. **Selección e índice.** Se excluyen estados `COMPLETED` antes de escoger una asignación por unidad. La memoria y Redis indexan solo rutas activas. Los avisos se deduplican por vigencia y por par candidata–ocupante; limpiar una ruta antigua nunca borra el cursor de la nueva.
22. **Trazabilidad de unidad.** Los avisos `assignment_skipped_completed` y `unit_already_in_route` añaden `unitId` de la fila sin cambiar su deduplicación. Se comprueban los valores de los campos, no solo que el evento haya ocurrido.

## Estructura
```
src/orchestrator/
  types.ts            interfaces de la spec, Event, Effect, StepTask
  serial.ts
  keyedMutex.ts
  transition.ts       funciones puras (filas 3-12 y avance de paso)
  stepRunner.ts       transmisión por la API, repetición, retransmisión
  assignmentCycle.ts  polling de asignaciones, inicio y cierre
  chainPoller.ts      polling de tramas y aplicación de eventos
  scheduler.ts        interfaz + FakeScheduler (tiempo controlado)
  bullmqScheduler.ts  adaptador fino sobre BullMQ
  orchestrator.ts     start/stop, recuperación al arrancar
  index.ts            única entrada pública
  *.test.ts
```

## Orden de trabajo
Tipos y serial → `transition.ts` con su tabla de pruebas → `FakeScheduler` y exclusión → `stepRunner` (transmisión, repetición, retransmisión) → `assignmentCycle` (inicio, cierre, ruta tipo 1) → `chainPoller` (aplicación, cursor tras aplicar) → recuperación al arrancar → adaptador de BullMQ → ruta completa de punta a punta con fakes.

Enmienda de estados: retirar la opción del margen → usar el predicado de 001 en inicio, cierre y retransmisión → probar estado 1, inicio 3/4, continuidad y cierre.

Enmienda de hora final y errores: eliminar la comparación → aislar selección/inicio por fila y contar fallos → añadir el descriptor común y aplicarlo a todos los registros pedidos → probar continuidad y redacción.

Enmienda de carga: actualizar contratos de 002/006 → limitador SQL compartido y pruebas de ventanas y fallos → cola por equipo y arranques pendientes → métricas por minuto → cableado y configuración → pruebas con reloj simulado → lint, build y tests.

Enmienda de particiones: marcas de 004 y selección de 001 → conservar el limitador en la ventana doble → reparar cursores futuros desde la transmisión del paso → pruebas de reinicio, registro y ausencia de ACK histórico.

Enmienda de entrada previa: actualizar la spec y T2 → limitar la fila 7 y añadir la fila 12 → evitar la consulta de plan para salidas prematuras → probar transición pura, lote mixto, tramas reales y reinicio → lint, build, tests y commit.

Enmienda de salida 2: actualizar 003 y sus cuatro fixtures reales → comprobar que el FSM ignora ACK `GTOUT` ajenos y cierra con el serial del paso → añadir `unitId` a los dos avisos de asignación y probar sus valores → lint, build, tests y commit.

## Riesgos
- El traductor de `jobId` tiene prueba unitaria. El adaptador completo de BullMQ queda sin prueba de integración automática porque Redis en memoria no soporta sus scripts; se verifica en el despliegue sombra.
- Una salida sin entrada en el paso ya no cuenta. Una salida duplicada o tardía puede completar el siguiente punto si ya hubo una entrada en él (limitación conocida, `docs/architecture.md` §10).
- Si el estado de Redis se pierde, las rutas en curso se reinician desde el primer punto: Redis debe correr con `appendonly yes` y `noeviction`.

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

## Estructura
```
src/orchestrator/
  types.ts            interfaces de la spec, Event, Effect, StepTask
  serial.ts
  keyedMutex.ts
  transition.ts       funciones puras (filas 3-11 y avance de paso)
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

## Riesgos
- El traductor de `jobId` tiene prueba unitaria. El adaptador completo de BullMQ queda sin prueba de integración automática porque Redis en memoria no soporta sus scripts; se verifica en el despliegue sombra.
- Una salida duplicada o tardía puede completar el siguiente punto (limitación conocida, `docs/architecture.md` §10).
- Si el estado de Redis se pierde, las rutas en curso se reinician desde el primer punto: Redis debe correr con `appendonly yes` y `noeviction`.

# Plan — 002-queue-orchestrator

## Estructura de archivos
```
src/orchestrator/
  types.ts
  fsm.ts              // lógica pura: (estado, evento) → nuevo estado, sin I/O
  worker.ts            // worker de BullMQ: conecta fsm.ts con 001/003/004/005
  fsm.test.ts
  worker.test.ts
```

## Decisiones técnicas
- **`fsm.ts` es una función pura**: `transition(state: RouteState, event:
  DomainEvent): RouteState`. No importa BullMQ, Redis ni red (principio
  III) — esto es lo que hace posible el criterio de aceptación "testeable
  sin BullMQ real ni Redis real".
- **`worker.ts` es la única pieza con I/O**: lee eventos de 001, llama a
  `transition`, persiste con 004, y cuando corresponde, llama a 003/005
  para enviar comandos. Aquí es donde vive el logging de
  `{timestamp, deviceId, routeId}` (ver `AGENTS.md`).
- BullMQ: cola única `site-lifecycle`; reintentos configurados con
  `ACK_MAX_RETRIES` / `ACK_RETRY_BACKOFF_MS` (ya definidos en `AGENTS.md`).

- **Intervalo adaptativo de consulta (polling) — NO es lo mismo que los
  reintentos de ACK, y nunca cancela ni falla nada.** Corrección respecto
  a una decisión anterior: `repeat: { every: ms }` (intervalo constante)
  no cumplía el requisito de `AGENTS.md` de administrar el polling. En su
  lugar, cada job de consulta, al terminar, encola el siguiente con
  `BullMQ.add(..., { delay })`: si hubo resultados nuevos, `delay =
  POLL_INTERVAL_MS_*` (intervalo base, consulta rápida); si NO hubo
  resultados, `delay` se duplica respecto al anterior, con tope de 5x el
  intervalo base — esto solo espacía la *siguiente pregunta a la BD*, es
  el equivalente a "si no hay nada nuevo, pregunto con menos frecuencia
  para no saturar la BD". **No marca nada como fallido, no cancela ningún
  job de envío de comando, y es completamente independiente del mecanismo
  de reintentos de ACK** (`ACK_MAX_RETRIES`/`ACK_RETRY_BACKOFF_MS`), que
  es el único que puede llevar un sitio a `FAILED`, y solo ese sitio
  específico — nunca la ruta completa ni otros dispositivos.

## Testing
- `fsm.test.ts`: tabla de casos (`estado inicial + evento → estado
  esperado`), sin mocks de ninguna librería — son objetos planos de
  entrada/salida, la forma más barata de testear las 6 transiciones.
- `worker.test.ts`: con fakes de las 4 dependencias (001, 003, 004, 005),
  para probar la integración completa sin tocar red ni BD real.

## Alternativas descartadas
- **Librería de FSM de terceros (xstate u otra):** descartada — la
  máquina tiene 6 estados y transiciones simples; una librería añadiría
  una dependencia y una curva de aprendizaje sin necesidad real
  (principio I).
# Spec 002 — Queue Orchestrator (FSM)

## Objetivo
Orquestar, mediante BullMQ, el avance de cada dispositivo a través de su
ruta: enviar el comando de configuración del sitio actual, esperar su ACK,
esperar entrada y salida de zona, avanzar al siguiente sitio, y cerrar la
ruta con el comando de reset.

## Fuera de alcance
- Construcción/parseo de comandos → `specs/003`.
- Consulta de eventos crudos → `specs/001`.
- Persistencia de estado → `specs/004`.
- Resolución de IP/puerto/modelo → `specs/005`.
Este es el único módulo que conoce y usa los cuatro anteriores juntos.

## Máquina de estados
```
PENDING → CONFIGURING → AWAITING_ACK → IN_ZONE → AWAITING_EXIT_ALERT
  → (siguiente sitio) PENDING → ... → COMPLETED
                      └→ FAILED (si se agotan los reintentos de ACK)
```

### Transiciones
- **PENDING → CONFIGURING**: hay un sitio pendiente en la ruta del dispositivo.
- **CONFIGURING → AWAITING_ACK**: se envió `sendGeoCommand` (003) con el
  comando del sitio actual. Se loggea `{timestamp, deviceId, routeId}` en
  este punto (requisito de `AGENTS.md`).
- **AWAITING_ACK → IN_ZONE**: el detector (001) reporta un evento `ack`
  para ese IMEI. Si no llega, se reintenta el envío hasta `ACK_MAX_RETRIES`
  veces (con `ACK_RETRY_BACKOFF_MS` entre cada uno, vía los reintentos de
  BullMQ). Si se agotan los reintentos sin ACK, la transición final es
  **AWAITING_ACK → FAILED** (estado terminal) — se loggea con
  `{timestamp, deviceId, routeId}` igual que cualquier otra transición.

**Supuesto documentado — routeId:** el esquema local (y lo poco confirmado
de la BD real) no tiene un identificador de ruta propio; se usa el IMEI
como `routeId` bajo el supuesto de una sola ruta activa por dispositivo a
la vez. Limitación conocida: si un dispositivo completara una ruta y
recibiera una nueva asignación el mismo día, ambas se verían idénticas en
logs. Se revisita cuando Paloma confirme el esquema real — si trae un ID
de asignación propio, se adopta ahí sin tocar la interfaz de `specs/002`.
- **IN_ZONE → AWAITING_EXIT_ALERT**: evento `zoneEvent` con `event='enter'`
  para la geocerca del sitio actual (informativo, no bloqueante).
- **AWAITING_EXIT_ALERT → PENDING (siguiente sitio) o COMPLETED**: evento
  `zoneEvent` con `event='exit'`. Si quedan más sitios, avanza
  `currentSiteIndex` y vuelve a `PENDING`; si era el último, envía el
  comando de reset (`Mode=0`, `specs/003`) y pasa a `COMPLETED`.

## Colas BullMQ
- Una sola cola `site-lifecycle`; un job por `{deviceId, routeId, siteIndex}`.
- Los reintentos de BullMQ (backoff configurado) implementan el reintento
  de ACK — no se reimplementa lógica de reintento a mano.
- Un worker separado consume los eventos del poller (001) y dispara
  transiciones sobre el `RouteState` correspondiente (004).

## Reglas de negocio
- Toda transición de estado se loggea con `timestamp, deviceId, routeId`
  (requisito ya definido en `AGENTS.md`).
- Toda transición se persiste en `RouteState` (004) **antes** de continuar
  — si el proceso se reinicia a medias, el estado en Redis debe permitir
  retomar sin reprocesar sitios ya completados.
- El comando de reset se envía siempre antes de marcar una ruta como
  `COMPLETED`, incluso si hubo reintentos previos.
- Este módulo es responsable de **programar** las consultas de `specs/001`
  (`getActiveRoutes`, `getNewEvents`) con un intervalo adaptativo: rápido
  mientras hay resultados nuevos, más espaciado (con tope) cuando no los
  hay — y de loggear y continuar en el siguiente ciclo si una consulta
  falla. **Este intervalo adaptativo es exclusivamente sobre la frecuencia
  de consulta a la BD — no cancela, no falla y no tiene ninguna relación
  con los reintentos de ACK descritos abajo.** 001 solo expone las
  funciones, 002 decide cuándo y con qué frecuencia llamarlas.

## Criterios de aceptación
- [ ] Una simulación de ruta de 2 sitios (con fakes de 001, 003 y 005 —
      004 puede ser real con `ioredis-mock`) pasa por todos los estados
      en el orden correcto.
- [ ] Un ACK que nunca llega dispara exactamente `ACK_MAX_RETRIES`
      reintentos y luego queda marcado como fallido — nunca se cuelga
      indefinidamente.
- [ ] El comando de reset se verifica enviado al completar la última ruta.
- [ ] Cada transición queda loggeada con los 3 campos requeridos.
- [ ] La lógica de FSM (transiciones) es testeable **sin BullMQ real ni
      Redis real** — solo con fakes de sus dependencias (principio III).
- [ ] Las consultas de 001 se disparan automáticamente a los intervalos
      configurados, sin intervención manual, y un fallo transitorio en
      una consulta se loggea y no detiene el ciclo siguiente.

## Fuera de alcance de esta iteración
- Procesamiento paralelo de más de 1-2 dispositivos simultáneos (funciona
  por diseño, pero no se prueba a esa escala todavía).
- Configuración del panel de monitoreo BullMQ (`npm run queue:board`, ya
  referenciado en `AGENTS.md`, pero fuera del alcance de esta spec).
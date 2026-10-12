# Spec 002 — Queue Orchestrator (FSM)

## Objetivo
Orquestar, mediante BullMQ, el avance de cada dispositivo a través de su
ruta: configurar el sitio actual, confirmar su ACK, detectar su salida de
zona, avanzar al siguiente sitio y cerrar la ruta desactivando la geocerca.

## Principio rector
Este middleware corre sin interfaz ni operador. Por eso:
- **Nunca se rinde:** un comando sin ACK se reintenta indefinidamente hasta
  obtenerlo. No existe estado `FAILED`, ni pausa para operador, ni límite
  terminal de intentos.
- **Nunca salta un sitio:** la ruta avanza al siguiente sitio únicamente
  tras el ACK y la salida de zona del sitio actual.
- **Nunca se detiene por un error:** un fallo en un dispositivo o en una
  consulta se registra y no afecta a otros dispositivos ni al siguiente
  ciclo.

## Fuera de alcance de esta spec
- Armado/envío/parseo de comandos → `specs/003`.
- Consulta de rutas y eventos crudos → `specs/001`.
- Persistencia de estado y cursor → `specs/004`.
- Resolución de modelo/IP/puerto → `specs/005`.
Este es el único módulo que usa los cuatro juntos.

## Estados
| Estado | Significado |
|---|---|
| `PENDING` | El paso actual aún no se ha enviado. |
| `CONFIGURING` | Se está enviando el comando del paso actual. |
| `AWAITING_ACK` | Comando enviado; esperando ACK; reintentos en curso. |
| `IN_ZONE` | ACK recibido, geocerca activa; esperando entrada o salida. (Nombre histórico: no implica que el equipo esté dentro.) |
| `AWAITING_EXIT_ALERT` | Entrada registrada; esperando salida. |
| `COMPLETED` | Ruta terminada y geocerca desactivada (ACK del reset recibido). |

No existe ningún estado de fallo. Un "paso" es un sitio de la ruta o, al
final, el **paso de reset**: `currentSiteIndex` igual al total de sitios
(comando `Mode=0` de `specs/003`). El reset sigue el mismo ciclo que
cualquier sitio, incluidos los reintentos de ACK.

## Transiciones
| # | Estado actual | Evento | Estado nuevo | Efecto |
|---|---|---|---|---|
| 1 | (IMEI sin `RouteState`) | asignación vigente detectada | `PENDING` (índice 0) | se crea el `RouteState` |
| 2 | `PENDING` | paso listo | `CONFIGURING` | — |
| 3 | `CONFIGURING` | comando enviado | `AWAITING_ACK` | envío UDP; inicia el lote 1 de reintentos |
| 4 | `AWAITING_ACK` (sitio) | `ack` | `IN_ZONE` | se cancelan los reintentos pendientes |
| 5 | `AWAITING_ACK` | lote agotado sin ACK | `AWAITING_ACK` (mismo paso) | log `warn` y se programa el siguiente lote |
| 6 | `IN_ZONE` | `zoneEvent` enter | `AWAITING_EXIT_ALERT` | informativo |
| 7 | `IN_ZONE` o `AWAITING_EXIT_ALERT` | `zoneEvent` exit, quedan sitios | `PENDING` (índice + 1) | — |
| 8 | `IN_ZONE` o `AWAITING_EXIT_ALERT` | `zoneEvent` exit, era el último sitio | `CONFIGURING` (índice = total, paso de reset) | — |
| 9 | `AWAITING_ACK` (paso de reset) | `ack` | `COMPLETED` | — |
| 10 | cualquiera | evento que no corresponde al estado (ACK duplicado, entrada repetida, etc.) | sin cambio | se ignora; log `debug` |

Cada reenvío exitoso conserva `AWAITING_ACK`, actualiza `lastCommandSentAt`
e incrementa `retryCount`; no cambia el paso. Si el envío UDP falla, no se
marca como enviado y BullMQ lo vuelve a intentar.

La entrada es informativa: una salida se acepta desde `IN_ZONE` aunque no se
haya visto la entrada.
La creación inicial de la fila 1 acepta ausencia de estado y guarda
`lastCommandSentAt: null`. El primer envío procesa `PENDING` o
`CONFIGURING`; los reenvíos procesan `AWAITING_ACK`.

## Reintentos de ACK (continuos, por lotes)
- Al entrar en `AWAITING_ACK` se envía el comando; si no llega ACK, se
  reenvía cada `ACK_RETRY_BACKOFF_MS` (espaciado fijo).
- **`ACK_MAX_RETRIES` = número de reenvíos por lote**, además del envío
  inicial. Agotar un lote **no es un fallo**: se emite un log `warn`
  (lote agotado, con `deviceId`, `routeId`, `siteIndex` y número de lote)
  y se inicia otro lote para el mismo paso, tras `ACK_RETRY_BACKOFF_MS`.
  Los lotes se repiten indefinidamente hasta recibir el ACK.
- El `warn` por lote es la señal operativa de que un equipo lleva tiempo
  sin responder; no detiene nada.
- Antes de cada reenvío se verifica el estado: si el paso ya no está en
  `AWAITING_ACK` (llegó el ACK), no se reenvía.
- Los ACK duplicados (producto de reenvíos) se ignoran (fila 10).
- `retryCount` cuenta únicamente reenvíos del paso actual (sitio o reset),
  acumulados entre lotes. El envío inicial no cuenta. Vale 0 en las filas
  1, 7 y 8; se incrementa y persiste en cada reenvío. Es informativo: nunca
  decide una pausa, fallo ni límite. Se incluye en cada log de reenvío y
  en el `warn` de lote agotado.
- Guía de configuración: `ACK_RETRY_BACKOFF_MS` debe ser mayor que la
  latencia observada entre el envío y la aparición del ACK en el reporte de
  cadenas más el intervalo de polling; si no, se reenviará sin necesidad.

## Ciclo de vida de la ruta
- Las filas vigentes se agrupan por IMEI y se ordenan por `orden`; el IMEI
  se usa como `routeId` (supuesto, ver abajo).
- Una asignación es **nueva** solo si su IMEI no tiene `RouteState`. Volver
  a recibir las mismas filas vigentes no reinicia ni reconfigura nada.
- Mientras el IMEI siga con filas vigentes, su `RouteState` se conserva
  (incluso en `COMPLETED`), para no reiniciar la ruta en cada consulta.
- Cuando el IMEI ya no aparece con filas vigentes y su estado es
  `COMPLETED`, se elimina su `RouteState` (queda libre para una asignación
  futura).

## Polling
- Dos consultas periódicas: rutas (`getActiveRoutes`, 001) y reporte de
  cadenas (`getNewEvents`, 001). Un solo poller de `reporte_cadenas` atiende
  ACKs y alertas (misma tabla, mismo cursor), por lo que usa un único
  intervalo base: `POLL_INTERVAL_MS_ACK`. `POLL_INTERVAL_MS_ALERTS` queda
  sin uso y se retira de `AGENTS.md`.
- **Intervalo adaptativo:** con novedad, la siguiente consulta usa el
  intervalo base; sin novedad, el retraso se duplica hasta un máximo de 5×
  el intervalo base. Novedad en rutas = un IMEI nuevo; en reportes = al
  menos una fila nueva.
- **Excepción:** mientras algún `RouteState` esté en `AWAITING_ACK`,
  `IN_ZONE` o `AWAITING_EXIT_ALERT`, el poller de reportes usa siempre el
  intervalo base (de lo contrario se retrasaría la detección del ACK o de
  la salida).
- Un error de consulta se registra, aplica el mismo espaciado y el
  siguiente ciclo se programa siempre.
- El espaciado del polling es independiente de los reintentos de ACK.

## Arranque y reinicio
- **Sin cursor guardado** (primer arranque): antes de procesar rutas
  nuevas, se drena el historial completo de `reporte_cadenas` descartando
  sus eventos, para que ACKs antiguos no completen un sitio recién
  configurado.
- **Con cursor guardado:** se procesan los eventos desde el cursor
  (incluye lo ocurrido mientras el proceso estuvo detenido).
- Tras cualquier arranque ninguna ruta queda detenida: cada `RouteState`
  en `PENDING`, `CONFIGURING` o `AWAITING_ACK` retoma el envío/reintentos
  de su paso actual; `IN_ZONE` y `AWAITING_EXIT_ALERT` siguen esperando
  eventos; `COMPLETED` no requiere acción. No deben duplicarse cadenas de
  reintentos ya activas.
- Cada transición se persiste en `RouteState` antes de ejecutar el
  siguiente efecto (envío, reencolado).

## Trazabilidad
- Cada transición y cada comando enviado (incluidos reenvíos y reset):
  `timestamp`, `deviceId`, `routeId`.
- Cada lote agotado: `warn` con además `siteIndex` y número de lote.
- Cada ciclo de polling: fuente, cantidad de resultados y próximo retraso.

## Criterios de aceptación
- [ ] Ruta de 2 sitios con fakes: pasa en orden por ACK, entrada, salida,
      avance, paso de reset, ACK del reset y `COMPLETED`.
- [ ] Con `ACK_MAX_RETRIES` pequeño y varios lotes sin ACK: nunca aparece
      un estado de fallo, nunca se salta el sitio, hay un `warn` por lote
      agotado, y al llegar el ACK la ruta continúa con normalidad.
- [ ] Al llegar el ACK se detienen los reenvíos; los ACK duplicados y las
      entradas repetidas se ignoran.
- [ ] Una salida se acepta desde `IN_ZONE` sin entrada previa.
- [ ] Un equipo que nunca responde no bloquea ni retrasa la ruta de otro.
- [ ] Rutas: las mismas filas vigentes repetidas no reinician un
      `RouteState` existente (tampoco uno `COMPLETED`); un IMEI que deja de
      estar vigente con estado `COMPLETED` pierde su `RouteState`.
- [ ] Polling: sin novedad el retraso se duplica hasta 5×; con novedad
      vuelve al base; un error se registra y el ciclo sigue; con equipos
      esperando eventos el poller de reportes se mantiene en el base.
- [ ] Arranque sin cursor: el historial se drena y un ACK antiguo no
      completa un sitio nuevo.
- [ ] Reinicio: un `RouteState` en `AWAITING_ACK` reanuda sus reintentos
      sin duplicar cadenas.
- [ ] Cada transición, comando y lote agotado queda registrado con los
      campos requeridos.
- [ ] La lógica de transición es testeable sin BullMQ, Redis ni red
      (principio III).

## Fuera de alcance de esta iteración
- Asignaciones que se cancelan o cambian a mitad de ruta.
- Intervención manual o reanudación: no existe pausa.
- Prueba a escala de más de 1-2 dispositivos simultáneos.
- Panel de monitoreo BullMQ (`npm run queue:board`).

## Supuestos y riesgos conocidos (no bloquean esta iteración)
- **routeId = IMEI:** hay una sola ruta activa por dispositivo en el esquema
  local. Si un equipo recibiera una nueva asignación tras completar una,
  ambas se verían iguales en los logs. Se revisa cuando Paloma confirme el
  esquema real.
- **Primer estado de la geocerca:** el comando usa `State Mode 0`, que según
  el manual reporta el estado la primera vez que se obtiene. Un equipo
  configurado estando fuera de la zona podría emitir una salida inmediata y
  adelantar el sitio. Validar en la prueba de campo; si ocurre, se corrige
  en `specs/003` (State Mode 1), no aquí.
- **ACK y salida tardíos:** 003 no correlaciona el ACK con un comando
  particular. Se acepta por IMEI solo en `AWAITING_ACK`; un ACK muy tardío
  podría atribuirse al paso siguiente. La geocerca usa el mismo ID en cada
  sitio; una salida duplicada o tardía también podría completar el sitio
  siguiente. Validar ambos casos en campo; no se modifica 001 ni 003 aquí.
- **Cursor adelantado:** 001 guarda el cursor al devolver un lote, antes de
  que 002 aplique sus eventos. Una caída entre ambos pasos podría perder
  eventos; se mantiene el contrato actual de 001 en esta iteración.

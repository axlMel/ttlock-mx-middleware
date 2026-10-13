# Simulación local — guía paso a paso

> Todo esto se hace contra la BD **local** de Docker. Nunca apuntes el
> `DATABASE_URL` de la simulación a la BD remota.

## 1. Cómo funciona (modelo mental)
- Node no tiene una consola tipo Rails. El arranque (`npm run dev`) inicia
  **un proceso que se queda corriendo**; lo "pruebas" mirando sus logs,
  Redis y Postgres.
- Ese proceso hace tres cosas en bucle:
  1. Cada cierto tiempo pregunta a Postgres por asignaciones de ruta vigentes.
  2. Cada cierto tiempo pregunta por filas nuevas de `reporte_cadenas`
     (ACKs y eventos de zona).
  3. Mientras una ruta está en curso, envía el comando UDP del paso actual
     y lo reintenta hasta recibir su ACK.
- Quién guarda qué: **Postgres** = datos de origen (el middleware solo
  lee; en la simulación los editas tú a mano). **Redis** = `RouteState`,
  cursor de `reporte_cadenas` y los jobs de BullMQ (consultas pendientes,
  reintentos).
- **Sí es automático:** al insertar una asignación vigente, el siguiente
  poll de rutas la detecta y arranca sola. Con el sistema ocioso ese poll
  puede tardar hasta 5× `POLL_INTERVAL_MS_ROUTES`.
- En la simulación **tú eres el equipo GPS**: `tools/fake-device.mjs`
  recibe los comandos UDP y te imprime el SQL del ACK que debes pegar.

## 2. Preparación (una sola vez)
1. Levantar servicios: `docker compose up -d` y verificar con
   `docker compose ps` (postgres y redis arriba).
2. Confirmar que las pruebas automáticas pasan: `npm test`.
3. Crear `.env` en la raíz (solo local, ya está en `.gitignore`):
   ```
   DATABASE_URL=postgres://gtlock_dev:gtlock_dev@127.0.0.1:5433/atagps_local
   REDIS_URL=redis://127.0.0.1:6379
   POLL_INTERVAL_MS_ROUTES=2000
   POLL_INTERVAL_MS_ACK=2000
   ACK_MAX_RETRIES=2
   ACK_RETRY_BACKOFF_MS=15000
   ```
   Con estos valores, un lote son 3 envíos separados por 15 s (≈ 30 s); el
   `warn` de lote agotado aparece tras ese tiempo.
4. Apuntar los equipos simulados a tu máquina y aparcar las rutas del seed
   (solo en la BD local):
   ```sql
   UPDATE resumen_unidad SET ip = '127.0.0.1'
     WHERE imei IN ('863457050476769', '868589060960328');
   UPDATE asignaciones_rutas SET estatus = 'cancelada';
   ```
5. Empezar limpio (borra TODO Redis; solo desarrollo):
   `docker compose exec redis redis-cli FLUSHALL`

## 3. Las cuatro terminales
| Terminal | Comando | Para qué |
|---|---|---|
| T1 | el arranque del middleware (`npm run dev`) | ver los logs |
| T2 | `node tools/fake-device.mjs` | el "equipo": recibe comandos y propone el ACK |
| T3 | `docker compose exec postgres psql -U gtlock_dev -d atagps_local` | actuar sobre la BD |
| T4 | `docker compose exec redis redis-cli` | mirar el estado |

Comandos útiles en T4:
```
KEYS route:*
GET route:863457050476769
GET cursor:reporte_cadenas
KEYS bull:site-lifecycle:*
ZRANGE bull:site-lifecycle:delayed 0 -1 WITHSCORES
```
El `GET route:...` muestra el `RouteState` (estado, índice del paso y
`retryCount`). El `ZRANGE ... delayed` muestra los jobs de BullMQ
esperando su turno (si no cambiaste el prefijo por defecto).

## 4. Recorrido guiado
Cada paso: **haces → deberías ver → qué aprendiste.**

### Paso 1 — Arranca el "equipo" (T2)
- Haces: `node tools/fake-device.mjs`.
- Ves: dos líneas "escuchando" (puertos 55010 y 55077) y la chuleta de SQL
  de entrada/salida.
- Aprendes: el middleware envía por UDP "a ciegas"; este script hace de
  equipo.

### Paso 2 — Arranca el middleware sin rutas (T1)
- Haces: arranca el middleware con las rutas aparcadas.
- Ves: el drenaje inicial del historial (no hay cursor guardado) y ciclos de
  polling sin novedad cuyo próximo retraso se duplica (2 s → 4 s → 8 s →
  tope de 10 s).
- En T4: `GET cursor:reporte_cadenas` devuelve un número, y
  `ZRANGE bull:site-lifecycle:delayed 0 -1 WITHSCORES` muestra los polls
  pendientes.
- Aprendes: el drenaje descarta las tramas viejas del seed (si no, sus ACKs
  podrían completar un sitio nuevo) y el polling se espacía cuando no hay
  nada que hacer.

### Paso 3 — Crea una asignación (T3) y mira cómo arranca sola
- Haces:
  ```sql
  INSERT INTO asignaciones_rutas (imei, latitud, longitud, radio, orden, estatus) VALUES
    ('863457050476769', 19.355383, -99.128206, 50, 1, 'vigente'),
    ('863457050476769', 19.360000, -99.130000, 60, 2, 'vigente');
  ```
- Ves, en menos de ~10 s: en T1 el log de ruta nueva y las transiciones
  `PENDING → CONFIGURING → AWAITING_ACK`; en T2 el comando recibido
  (`SITIO`, serial `0000`) con el SQL del ACK; en T4 `GET route:8634...`
  con `fsmState: AWAITING_ACK`.
- Aprendes: nadie "llamó" al orquestador; el polling lo detectó. Un IMEI
  sin `RouteState` es una ruta nueva.

### Paso 4 — No respondas y observa los reintentos
- Haces: espera sin pegar el ACK.
- Ves: T2 recibe el **mismo comando con el mismo serial** cada 15 s;
  `retryCount` sube en el `RouteState`; tras ≈ 30 s aparece el `warn` de
  lote agotado y los reenvíos continúan.
- Aprendes: no existe `FAILED` ni pausa; un lote agotado solo avisa.

### Paso 5 — Responde el ACK
- Haces: pega en T3 el `INSERT` del ACK que imprimió T2.
- Ves: `AWAITING_ACK → IN_ZONE`; T2 deja de recibir reenvíos.
- Aprendes: el ACK llega por la BD (reporte de cadenas), no por el socket
  UDP; el serial del ACK debe coincidir con el del paso.

### Paso 6 — Entrada
- Haces: pega el `INSERT` de entrada de la chuleta (GV300W).
- Ves: `IN_ZONE → AWAITING_EXIT_ALERT`.

### Paso 7 — Salida: avanza al siguiente sitio
- Haces: pega el `INSERT` de salida.
- Ves: el índice sube a 1, `PENDING → CONFIGURING → AWAITING_ACK`, y T2
  recibe el comando del sitio 2 con serial `0001`.

### Paso 8 — Segundo sitio y paso de reset
- Haces: pega el ACK (serial `0001`), la entrada y la salida.
- Ves: T2 recibe un comando con `RESET (Mode=0)` y serial `0002`.
- Aprendes: el reset es un paso más de la ruta, con su propio ACK.

### Paso 9 — ACK del reset
- Haces: pega el ACK del reset.
- Ves: `COMPLETED` (el índice queda en 2). El `RouteState` **se conserva**
  mientras la asignación siga vigente, para no reiniciar la ruta en cada poll.

### Paso 10 — Cierra la asignación
- Haces: `UPDATE asignaciones_rutas SET estatus = 'completada' WHERE imei = '863457050476769';`
- Ves: en el siguiente poll de rutas, `KEYS route:*` queda vacío.
- Aprendes: un IMEI que ya no está vigente y está `COMPLETED` libera su
  estado; una asignación futura arrancaría de cero.

## 5. Casos límite (experimentos)
Para cada uno: reinicia limpio (`FLUSHALL` + aparcar rutas), crea la
asignación del paso 3 y llega hasta donde indica.

| # | Haz | Esperado según la spec |
|---|---|---|
| E1 | Pega dos veces el mismo ACK | El segundo se ignora; sin cambios de estado |
| E2 | Responde con serial `FFFF` en vez del esperado | Se ignora; siguen los reintentos |
| E3 | Tras el ACK, pega la **salida** sin entrada | Se acepta; avanza al siguiente paso |
| E4 | No respondas durante varios lotes; luego responde | Un `warn` por lote; al llegar el ACK la ruta continúa |
| E5 | Ctrl+C en T1 estando en `AWAITING_ACK`; vuelve a arrancar | Retoma los reintentos; T2 recibe **un** comando cada 15 s, no dos |
| E6 | Ctrl+C estando en `IN_ZONE`; pega la salida con T1 apagado; arranca | Procesa lo ocurrido desde el cursor y avanza |
| E7 | Segunda asignación para el GV310LAU (`868589060960328`, mismo patrón; usa GTGIN/GTGOT) y no respondas a uno | El otro equipo avanza sin retraso |
| E8 | Con una ruta activa, `docker compose stop postgres`, espera, `docker compose start postgres` | El proceso no se cae; registra errores y se recupera |
| E9 | Igual con `docker compose stop redis` | La spec **no define** este caso: anota qué pasa |
| E10 | Deja la misma asignación vigente varios polls | No se reinicia ni reconfigura; sin "ruta nueva" repetida |
| E11 | Tras `COMPLETED`, marca `completada` y luego inserta una asignación vigente nueva | Se borra el estado y la nueva arranca desde el sitio 1 |
| E12 | Inserta ruido en `reporte_cadenas`: `'basura'` y una trama de otro tipo, p. ej. `'+RESP:GTFRI,270D04,863457050476769,,,,,'` | Se ignoran; sin caídas |
| E13 | Asignación para un IMEI que no está en `resumen_unidad`, y otra para `000000000000000` (modelo inválido) | La spec **no define** el comportamiento: anótalo |
| E14 | Ruta de un solo sitio | Tras la salida pasa directo al reset |
| E15 | Tras el ACK del sitio 2 (ya en el segundo sitio), pega una **segunda salida** | Limitación conocida documentada: puede completar el sitio 2 antes de tiempo |

## 6. Qué hacer con lo que encuentres
- Si el comportamiento **coincide** con lo esperado: perfecto, anótalo.
- Si **no coincide**, o la spec no define el caso, es un **hallazgo**.
  Regístralo así y corrígelo siguiendo SDD (primero la spec, luego el
  código):

  | Hallazgo | Qué hice | Qué esperaba la spec | Qué pasó | ¿Spec ambigua? |
  |---|---|---|---|---|

- Revisa también que cada transición y cada comando tengan `timestamp`,
  `deviceId` y `routeId` en el log.
- Las tramas de prueba van sin `$` final, igual que el seed y las pruebas
  de 003. Si la BD real las guarda con `$` u otro encuadre, valídalo con
  Gustavo antes del despliegue.

## 7. Reiniciar el escenario
```
docker compose exec redis redis-cli FLUSHALL
```
```sql
UPDATE asignaciones_rutas SET estatus = 'cancelada';
```
Para volver al seed original completo (solo desarrollo; borra los datos de
Postgres local): `docker compose down -v && docker compose up -d`
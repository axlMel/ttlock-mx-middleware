# docs/architecture.md — gtlock-middleware

> Documento vivo: hechos confirmados del entorno real y decisiones de arquitectura.
> Los principios viven en `constitution.md`, la guía operativa en `AGENTS.md` y el
> comportamiento de cada módulo en `specs/`. Si algo de aquí contradice una spec,
> se corrige por escrito el documento equivocado; nunca se resuelve en silencio en el código.

## 1. Qué hace el sistema
1. Lee de la BD de GlobalTrack (solo lectura) las asignaciones de viaje vigentes de las empresas habilitadas.
2. Cuando una asignación está por iniciar, resuelve su unidad, dispositivo y modelo, y lee los puntos de su ruta con coordenadas y radio.
3. Configura en el equipo, uno por uno, la geocerca del punto actual (`AT+GTGEO`). **El envío lo hace la API de comandos**, no el middleware.
4. Espera el ACK del equipo y su salida de zona leyendo las tramas de `tbl_cadena`.
5. Pasa al siguiente punto. Al terminar la ruta, o cuando la asignación deja de ser vigente, desactiva la zona (reset, `Mode=0`).
6. Nunca se rinde, nunca salta un punto y nunca se detiene por un error.

La v1 atiende rutas **con orden** (`int_tipo = 0`). Las rutas desordenadas están planificadas (§11).

## 2. Reglas de acceso a datos (política de los dueños de las tablas)
- Solo lectura. Nunca se escribe en la BD externa (principio V).
- **Sin JOINs** y sin `SELECT *`: solo las columnas necesarias.
- Solo llaves primarias e índices ya existentes. No se crean índices.
- Nunca se trae una tabla completa.
- El middleware guarda datos localmente (Redis) y los revalida por `dt_modificacion` en lugar de consultar siempre (spec 005).
- Consultas siempre parametrizadas. Pool pequeño (máx. 3 conexiones) y `statement_timeout` de 5 s.

## 3. Mapa de datos
| Dato | Tabla | Cómo se consulta |
|---|---|---|
| Asignaciones vigentes | `catalogos.tbl_asignacion_viaje` | `(int_idempresa, int_estado)`, índice `empresa_por_estado4` |
| Una asignación | `catalogos.tbl_asignacion_viaje` | `int_id` (llave primaria) |
| Unidad | `catalogos.tbl_unidad` | `int_id` |
| Dispositivo y modelo | `catalogos.tbl_dispositivo` | `int_id`; modelo `25` = GV300W, `100` = GV310LAU (mapa estático en código) |
| Tipo de ruta | `catalogos.tbl_ruta` | `int_id`; `int_tipo`: `0` con orden, `1` desordenada |
| Puntos de la ruta | `catalogos.tbl_punto_ruta` | `(int_idempresa, int_idruta)`. Siempre esta tabla; las versiones se ignoran |
| Sitio (coordenadas y radio) | `catalogos_gis.tbl_sitio` | `int_id`; `g_posicion` (punto) e `int_radio` en metros |
| Tramas del equipo | `tbl_cadena."YYYYWW"` | `(int_iddispositivo, dt_trama)`, índice `idx_dispositivo_fecha` |

Relaciones: asignación → unidad → dispositivo → modelo; asignación → ruta → puntos (por `int_orden`) → sitio.
Las tramas se identifican por `int_iddispositivo`.

## 4. Estados de la asignación
Vigente ⇔ `bol_enuso` e `int_estado` ∈ {3, 4}. `bol_enuso = false` equivale a asignación eliminada. Es lo único que el middleware atiende.

| `int_estado` | Nombre | Tratamiento |
|---|---|---|
| 1 | Asignada | Espera: con unidad asignada, aún no es hora de salir. No se configura. |
| 3, 4 | ATiempo, Tarde | **Vigente.** 3 = a tiempo de salir; 4 = unidad retrasada, lista para salir. De 3 a 4 se sigue con la misma ruta. |
| 2, 5, 6, 7 | Cumplida, Cancelado, Incumplida, Terminar | Deja de ser vigente. Si había ruta en curso: reset y limpiar. El estado final se registra. |
| -1, 0 | CanceladoEDI, SinAsignar | Nunca vigente. |

**Inicio de ruta:** asignación vigente. La hora final (`dt_hora_final`) solo se llena cuando la asignación termina, por un usuario o por el sistema, y no interviene: decide el estado.
**Zona horaria:** toda la BD guarda **UTC** (verificado: `dt_registro` de una asignación recién creada iba 6 horas adelante de la hora local). `ASSIGNMENT_TZ = UTC`.

## 5. Tramas por partición semanal
- Una partición nueva por semana, con nombre `YYYYWW`, creada los jueves a las 00:00 UTC. Ejemplo: la `202645` empieza el 2026-11-05 00:00:00.029815.
- Permisos siempre vigentes desde tres meses atrás hasta la semana actual; no se piden cada semana.
- Índices: `idx_hora (dt_trama)` e `idx_dispositivo_fecha (int_iddispositivo, dt_trama)`. `int_id` es llave primaria y crece entre particiones.
- **El nombre no se calcula con una fórmula**: se descubre consultando el catálogo (`pg_namespace`, `pg_class`) al arrancar y cada `PARTITION_REFRESH_MS`. La semana 1 y el día de corte cambian cada año.
- **Lectura por equipo**: una consulta por equipo en espera, secuencial, desde un solo poller, usando `idx_dispositivo_fecha`. El costo en la BD crece con el número de equipos en espera, no con el tráfico de la plataforma.

## 6. API de comandos
`POST https://metrics.globaltrack.com.mx/udp-api/api/v1/commands/send`
Encabezados: `Content-Type: application/json`, `X-API-Key`, `Idempotency-Key`.
Cuerpo: `{ "companyId": <id de la API>, "unitId": "<int_idunidad>", "comando": "<AT+GTGEO...$>" }`.

- `companyId` es el id propio de la API por empresa: pruebas (LAB) = 2, SODISA producción = 1. No es el `int_idempresa` de la plataforma (SODISA = 364).
- `SENT_UNCONFIRMED`: el socket aceptó la transmisión; no demuestra que el equipo la recibió. Los ACK llegan a SphereGT y se leen de `tbl_cadena`.
- `OUTCOME_UNKNOWN`: no se asume entrega ni ausencia de entrega; se registra y se espera el ACK.
- Códigos: 200 ok; 401 clave inválida; 403 origen o consumidor no permitido; 404 unidad no encontrada o no autorizada; 409 conflicto de clave o destino; 422 entrada inválida; 503 transmisión deshabilitada o no disponible.

**Política de transmisión (validada por Ever y Gustavo):** `AT+GTGEO` es configuración idempotente.
- Misma petición por error de red o resultado incierto → **misma `Idempotency-Key` y mismo JSON**.
- Sin ACK al vencer la ventana → **clave nueva** (nueva transmisión del mismo comando).
- Nunca se crea una clave nueva para reintentar a ciegas una petición de resultado incierto.
- La clave y el JSON se guardan antes de llamar a la API.

## 7. Configuración
| Variable | Por defecto | Uso |
|---|---|---|
| `DATABASE_URL` | — | BD de GlobalTrack, solo lectura, secreto entregado por LoadCredential, no por .env |
| `REDIS_URL` | — | Estado, cursores, caché y cola. Secreto entregado por redis-url |
| `ENABLED_COMPANIES` | — | Pares `plataforma:api` separados por coma. Pruebas `364:2`; producción `364:1` |
| `ASSIGNMENT_TZ` | `UTC` | Zona de `dt_hora_inicial` y `dt_hora_final` (confirmada) |
| `POLL_INTERVAL_MS_ROUTES` | `10000` | Consulta de asignaciones (espaciado adaptativo, hasta 5×) |
| `POLL_INTERVAL_MS_ACK` | `3000` | Consulta de tramas mientras haya equipos esperando |
| `ACK_RETRY_BACKOFF_MS` | `60000` | Espera del ACK tras cada transmisión antes de retransmitir |
| `ACK_MAX_RETRIES` | `3` | Retransmisiones por lote antes de un aviso; los lotes continúan |
| `ACK_RESEND_ENABLED` | `true` | Interruptor de seguridad de la retransmisión |
| `CATALOG_REVALIDATE_MS` | `300000` | Edad máxima de un dato en caché antes de revalidarlo |
| `CHAIN_BATCH_LIMIT` | `500` | Filas máximas por consulta de tramas |
| `CHAIN_OVERLAP_MS` | `10000` | Solapamiento del cursor de tramas |
| `PARTITION_REFRESH_MS` | `600000` | Redescubrimiento de particiones |
| `COMMAND_API_URL` | — | URL de la API de comandos |
| `COMMAND_API_KEY` | — | Secreto. Nunca en el repo ni en logs, entregado por LoadCredential, no por .env |
| `COMMAND_API_TIMEOUT_MS` | `10000` | Timeout por llamada |
| `COMMAND_DRY_RUN` | `false` | Modo sombra: no llama a la API |
| `AUDIT_LOG_DIR` | `./audit` | Auditoría de comandos (JSON Lines por día) |
| `CREDENTIALS_DIRECTORY` | — | Variable que pone systemd |

## 8. Despliegue por fases (sin pruebas locales)
1. **Modo sombra** (`COMMAND_DRY_RUN=true`): lee la BD real y calcula todo, pero solo registra el comando que enviaría.
2. **Unidad de pruebas**: el equipo de prueba ya está en la cuenta de SODISA (plataforma 364); la API se usa con su `companyId` de pruebas (`ENABLED_COMPANIES=364:2`).
3. **Producción** (`364:1`), empezando con una unidad.

## 9. Seguridad
- Solo hay salidas de red: BD (TCP 5500), API (HTTPS) y Redis local. No se escucha en ningún puerto.
- `buildGeoCommand` valida lat, lon, radio y serial antes de armar un comando. Es la defensa contra datos corruptos de la BD.
- El nombre de partición solo se acepta si cumple `^[0-9]{6}$` y proviene del catálogo.
- Redis sin puerto público y con contraseña. Usuario de BD de solo lectura. Ningún secreto en logs.
- Pendiente: spec 008 de seguridad (revisión de dependencias, rotación de claves).

## 10. Supuestos y riesgos conocidos
- `dt_trama` se asume hora de recepción en UTC (tiene microsegundos). Si resultara ser hora del equipo, el cursor por tiempo dejaría de ser válido.
- Una asignación vigente por unidad. Si hay dos, se atiende la de `dt_hora_inicial` más temprana y se avisa.
- Cambios al punto actual mientras se espera su salida se aplican al siguiente paso (limitación de la v1).
- Cambio de partición: una trama insertada tarde en la partición anterior después del cambio no se lee (riesgo bajo).
- `State Mode 0` (spec 003): un equipo configurado fuera de la zona podría reportar una salida inmediata. Validar en la fase 2.
- Una salida duplicada o tardía del punto anterior podría completar el siguiente. Validar en la fase 2.
- Las rutas desordenadas (`int_tipo = 1`) aún no se atienden: se detectan y se omiten con alerta.

## 11. Rutas desordenadas (planificado, fuera de la v1)
`catalogos.tbl_ruta.int_tipo`: `0` ruta con orden (v1), `1` ruta desordenada. En una ruta desordenada se configuran
todos los puntos de una vez y el equipo los guarda hasta que la ruta termina.

- **Zonas:** `AT+GTGEO` con `id` de 0 a 19 (un punto por id).
- **Reglas:** `AT+GTUDF`, un par por punto (entrada y salida), apoyadas en el `GTCMD` ya configurado, que es fijo. El equipo tiene 32 slots UDF y cada punto usa 2: máximo 16 puntos. Se usarán **15** (30 slots) y quedan 2 libres para reglas externas.
- **Flujo:** configurar los puntos (un ACK por comando) → el equipo opera solo y reporta entradas y salidas con el id de cada zona → el middleware registra los puntos visitados → al terminar, desactivar todo (reset).
- **Pendiente de definir:** formatos del GV310LAU, qué hacer con rutas de más de 15 puntos, y el intervalo de revisión de las zonas (el formato que nos diste usa 0; el de la ruta con orden usa 30).

**Ganchos que se incluyen desde ya, para no rehacer trabajo:**
1. **003:** `buildGeoCommand` recibe el `id` de zona como parámetro (hoy siempre 0) y el módulo deja espacio para armar `AT+GTUDF`.
2. **005:** el plan de ruta incluye `routeType`, leído de `catalogos.tbl_ruta` por llave primaria.
3. **004:** `RouteState` guarda `routeType`.
4. **002:** una asignación de tipo `1` se detecta y se **omite con alerta**; nunca se procesa como ruta con orden.
5. La FSM de rutas desordenadas será una spec propia (009).

## 12. Alta de un cliente nuevo
1. Acordar con Ever el `companyId` de la API para esa empresa.
2. Añadir el par `plataforma:api` a `ENABLED_COMPANIES`.
3. Reiniciar en modo sombra (`COMMAND_DRY_RUN=true`) y comprobar que se leen sus asignaciones.
4. Probar con una unidad del cliente antes de habilitar las demás.

No hay recarga en caliente en la v1. Un modelo de dispositivo nuevo exige cambiar el mapa de modelos y añadir su perfil de protocolo (spec 003).

## 13. Retiros y orden de la transición
| Cuándo | Qué | Por qué |
|---|---|---|
| Ahora | `docs/simulacion-local.md` y `tools/fake-device.mjs` | Ninguna prueba los usa |
| Inicio de la tanda 1 | Mover el código antiguo de `src/event-detectors/`, `src/orchestrator/`, `src/device-directory/` y `src/app/` a `legacy/`, fuera de `tsconfig` y de las pruebas | Dependen de contratos que 004, 003 y 005 van a cambiar; así `npm test` sigue en verde mientras se reescriben |
| Fin de la tanda 1 | `docker-compose.yml`, `local-db/`, valores locales de `.env.example` y menciones a Docker en `AGENTS.md` | Sin el código antiguo ninguna prueba necesita la BD local |
| Fin de la tanda 3 | `legacy/` | Ya fue reemplazado por 001, 002 y 006 nuevos |
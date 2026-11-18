# Spec 006 — Arranque de la aplicación (configuración, cableado y apagado)

> Carpeta `specs/006-app-bootstrap`; código en `src/config/` y `src/main.ts` (más `src/app/`).
> Esta versión **reemplaza** el contenido anterior de la carpeta.

## Objetivo
Leer y validar la configuración, leer los secretos de forma segura, construir las dependencias
reales, conectarlas entre sí, arrancar el orquestador y apagarlo de forma ordenada. Es el único
lugar que lee `process.env` y el único que conoce todas las piezas.

## Fuera de alcance
- La unidad de systemd, la creación de los archivos de credenciales, la rotación de la clave y la limpieza de Redis al salir del modo sombra → `specs/008`.
- Lógica de negocio: está en 001, 002, 003, 005 y 007.
- Puertos de entrada: el servicio **no abre ningún puerto** (`docs/architecture.md`).

## Configuración
Variables (defaults en `docs/architecture.md` §7):

| Variable | Regla de validación |
|---|---|
| `ENABLED_COMPANIES` | Obligatoria. Pares `plataforma:api` separados por coma (`364:2`). Enteros positivos, sin plataformas repetidas. |
| `ASSIGNMENT_TZ` (`UTC`) | Zona IANA válida (se comprueba con `Intl.DateTimeFormat`). |
| `START_MARGIN_MINUTES` (15), `POLL_INTERVAL_MS_ROUTES` (10000), `POLL_INTERVAL_MS_ACK` (3000), `ACK_RETRY_BACKOFF_MS` (60000), `CATALOG_REVALIDATE_MS` (300000), `PARTITION_REFRESH_MS` (600000), `COMMAND_API_TIMEOUT_MS` (10000) | Enteros positivos. |
| `ACK_MAX_RETRIES` (3), `CHAIN_BATCH_LIMIT` (500) | Enteros ≥ 1. |
| `CHAIN_OVERLAP_MS` (10000) | Entero ≥ 0. |
| `ACK_RESEND_ENABLED` (`true`), `COMMAND_DRY_RUN` (`false`) | Solo `true` o `false`. |
| `COMMAND_API_URL` | Obligatoria. URL `https://`. |
| `AUDIT_LOG_DIR` (`./audit`) | Ruta no vacía. Se crea si no existe y se comprueba que puede escribirse antes de abrir conexiones; si falla, error de configuración (78). |
| `REDIS_URL` | Obligatoria. URL `redis://` o `rediss://`. |

### Secretos
Dos valores son secretos: la **API key de comandos** y la **URL de la BD** (contiene la contraseña).
- Se leen primero de archivos de credenciales de systemd: `${CREDENTIALS_DIRECTORY}/command-api-key` y `${CREDENTIALS_DIRECTORY}/database-url` (contenido recortado de espacios y saltos de línea).
- Si el archivo no existe, se usan las variables de entorno `COMMAND_API_KEY` y `DATABASE_URL` (para pruebas manuales en un equipo de desarrollo). Si no hay ninguna de las dos fuentes, es un error de configuración.
- `DATABASE_URL`, tras leerse, debe ser `postgres://` o `postgresql://`.
- Los secretos **nunca** aparecen en logs, errores, auditoría ni en la configuración que se registra al arrancar (se muestran como `***`). Un error de lectura nombra la fuente (la variable o el archivo), nunca el valor.

### Errores de configuración
Se validan **todas** las variables y se reporta la lista completa en español (variable, problema), de una vez. Con algún error el proceso termina con código **78** sin abrir conexiones.

## Interfaces
```typescript
interface AppConfig { /* una propiedad por variable, ya convertida; secretos en apiKey y databaseUrl */ }
function loadConfig(env: Record<string, string | undefined>, readFile: (path: string) => string): AppConfig;   // lanza ConfigError con la lista completa
function redactConfig(config: AppConfig): Record<string, unknown>;                                            // para registrar, sin secretos

interface AppFactories {        // inyectables para pruebas
  createPool(config: AppConfig): PgPool;
  createRedis(config: AppConfig, role: 'state' | 'queue'): RedisLike;
  createScheduler(config: AppConfig, redis: RedisLike): Scheduler;   // BullMQ (spec 002)
  now(): number;
}
interface App { start(): Promise<void>; shutdown(reason: string): Promise<void>; }
function buildApp(config: AppConfig, logger: Logger, factories: AppFactories): App;
```
`src/main.ts` solo une `loadConfig` con `process.env`, el logger real, las fábricas reales y las señales; no tiene lógica propia.

## Cableado (`buildApp`)
- **Pool de PostgreSQL:** máximo **3** conexiones, `statement_timeout` de **5 s**, `application_name = gtlock-middleware`. Un `SqlClient` (spec 001) adapta `pool.query`.
- **Redis:** una conexión para estado y caché (004) y otra para BullMQ (con `maxRetriesPerRequest: null`, que BullMQ exige).
- **Gateway y auditoría (007):** `createAuditLog(AUDIT_LOG_DIR)` y `createCommandGateway(audit, { apiUrl, apiKey, timeoutMs, dryRun })`.
- **Detectores (001):** `ChainReader` creado con `onAlert` que escribe en el **mismo `Logger`** que recibe el orquestador (`chain_alert`, nivel `warn`).
- **Orquestador (002):** recibe `dryRun` con **el mismo valor** que el gateway (una sola lectura de `COMMAND_DRY_RUN`) y `enabledCompanies` convertido a `Map`.
- Todo se importa solo desde las entradas públicas (`index.ts`) de cada módulo.

## Arranque
En este orden, y si algo falla el proceso termina con código 1 y el motivo en el log (systemd lo reiniciará):
1. `loadConfig` (código 78 si hay errores).
2. Se registra la configuración **sin secretos** (`redactConfig`).
3. Se crea y comprueba `AUDIT_LOG_DIR`; un fallo de permisos o de ruta termina con código 78 sin abrir conexiones.
4. Se prueba PostgreSQL (`SELECT 1`) y Redis (`PING`).
5. Se consulta `CONFIG GET appendonly` y `CONFIG GET maxmemory-policy`: si no son `yes` y `noeviction`, **aviso** (no error); si `CONFIG` no está permitido, se registra a nivel `info` y se continúa.
6. Se construyen las dependencias (sección anterior).
7. Si `COMMAND_DRY_RUN = true`: aviso `shadow_mode_active` (nivel `warn`).
8. `orchestrator.start()`.

**No hay drenaje de historial** ni precarga de catálogos. Las rutas en curso se retoman desde Redis (spec 002).

## Latido
Cada 60 s se registra un `heartbeat` con: `dryRun`, número de rutas por estado (`list()` de `RouteStateStore`, solo conteos) y la hora del último ciclo de asignaciones y de tramas si el orquestador las expone. Como el servicio no abre puertos, es la señal de vida visible en los logs.

## Apagado
- `SIGTERM` o `SIGINT`: `shutdown`: detener el orquestador (espera lo que esté en curso, con un límite de **25 s**); `orchestrator.stop()` de 002 ya cierra el `Scheduler`. Después cerrar Redis y el pool, sin cerrar el `Scheduler` una segunda vez; salir con código 0 si todo terminó correctamente.
- Una segunda señal durante el apagado fuerza la salida con código 1.
- `uncaughtException` y `unhandledRejection`: se registra el error a nivel `error` y se sale con código 1. El estado vive en Redis, así que reiniciar es seguro.

## Criterios de aceptación
- [ ] `loadConfig` convierte y valida cada variable de la tabla; con defaults devuelve los valores de `architecture.md` §7.
- [ ] Con varias variables inválidas, `ConfigError` lista **todas** (variable y problema), en español.
- [ ] Los secretos se leen de `CREDENTIALS_DIRECTORY` primero y de las variables de entorno como respaldo; sin ninguna fuente, error.
- [ ] `redactConfig` y todo lo que se registra al arrancar no contienen la API key ni la contraseña de la BD (prueba con valores reconocibles).
- [ ] `ENABLED_COMPANIES` se convierte en `Map` y rechaza duplicados y pares mal formados.
- [ ] El gateway y el orquestador reciben el **mismo** valor de `dryRun`.
- [ ] El `onAlert` del lector de tramas escribe en el `Logger` del orquestador.
- [ ] El pool se crea con máximo 3 conexiones y `statement_timeout` de 5 s.
- [ ] El orden de arranque se respeta; si falla la prueba de PostgreSQL o Redis, no se llama a `orchestrator.start()`.
- [ ] `CONFIG GET` con valores distintos genera aviso; si no está permitido, el arranque continúa.
- [ ] `shutdown` invoca `orchestrator.stop()` una vez (002 cierra el `Scheduler`), luego cierra Redis y el pool, en ese orden y sin doble cierre del `Scheduler`.
- [ ] Una segunda señal fuerza la salida.
- [ ] No hay drenaje de historial ni lectura de catálogos al arrancar.
- [ ] Las pruebas usan fábricas falsas, un `readFile` falso y reloj controlado; no hay red, BD ni Redis reales.

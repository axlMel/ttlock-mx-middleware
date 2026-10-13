# Plan — 006-app-bootstrap

## Estructura de archivos

```text
src/app/
  config.ts             // lectura y validación de variables de entorno
  bootstrap.ts          // composición y ciclo de vida de recursos
  main.ts               // entrada ejecutable y señales del proceso
  config.test.ts
  bootstrap.test.ts
  main.test.ts
src/orchestrator/
  worker.ts             // liberar recursos propios si falla su arranque
  worker.test.ts        // caso de fallo al iniciar, sin cambiar el negocio
tsconfig.build.json     // salida JavaScript en dist/, sin archivos de test
package.json            // scripts build, dev, prestart y start en la raíz
package-lock.json       // metadato de versión mínima de Node sincronizado
.env.example            // nombres y valores de ejemplo para desarrollo local
```

La configuración compartida de TypeScript, Jest y ESLint permanece en la
raíz. No se agrega ninguna dependencia npm.

## Decisiones técnicas

- **Carga de entorno:** `config.ts` valida `DATABASE_URL` y `REDIS_URL` como
  cadenas no vacías y reutiliza `configFromEnv` de 002 para los cuatro
  valores numéricos. No define defaults silenciosos ni usa `dotenv`.
- **Scripts:** `build` compila con `tsc -p tsconfig.build.json`; `dev`
  compila y ejecuta `node --env-file=.env dist/app/main.js`; `prestart`
  compila y `start` ejecuta `node dist/app/main.js`. Así desarrollo puede
  usar `.env`, mientras producción recibe las variables de su entorno. El
  script `dev` exige Node 20.6 o posterior, versión que introdujo
  `--env-file`; ajustar `engines.node` a `>=20.6` y sincronizar el lockfile.
- **Composición:** crear un `pg.Pool` con `DATABASE_URL` para
  `PgRouteDetector` y `PgChainReportDetector`. Crear un cliente `ioredis`
  con `REDIS_URL` para `RedisPollingCursorStore` y `RedisRouteStateStore`.
  Instanciar `PgDeviceDirectory(DATABASE_URL)`: su contrato actual crea un
  segundo `Pool` propio; cerrarlo mediante `deviceDirectory.close()` además
  del `Pool` compartido. `startBullWorker` crea y cierra internamente la
  conexión Redis de BullMQ y usa por defecto las funciones reales de 003.
  El punto de entrada es la raíz de composición, por lo que importa los
  adaptadores concretos; la FSM y los contratos de dominio no cambian.
- **Disponibilidad:** comprobar las conexiones explícitas con una consulta
  PostgreSQL de solo lectura (`SELECT 1`) y `PING` de Redis antes de
  `startBullWorker`. La conexión del directorio se abre bajo demanda con su
  implementación actual. Esperar `startBullWorker`, que invoca
  `orchestrator.start()` y programa el trabajo inicial. No llamar de nuevo
  a `orchestrator.start()` ni implementar drenaje/polling/reanudación aquí.
- **Propiedad y cierre:** `bootstrap.ts` devuelve un manejador `close()`
  idempotente. En orden, espera `worker.close()` (incluye cola y su Redis),
  `deviceDirectory.close()`, `pool.end()` y `redis.quit()` cuando Redis esté
  listo; si la conexión nunca llegó a estar lista durante un arranque
  fallido, usar `redis.disconnect()` para no esperar indefinidamente una
  reconexión. Si un cierre falla, continúa con los restantes y comunica el
  fallo. El mismo cierre de
  recursos parcialmente construidos se aplica al error de arranque.
  `startBullWorker` debe liberar su worker, cola y conexión Redis si
  `orchestrator.start()` falla antes de devolver su manejador. Antes de
  cambiar ese adaptador, documentar el contrato de limpieza en la spec y
  las tasks de 002; no alterar su política de jobs ni la FSM.
  `main.ts` registra manejadores de `SIGINT` y `SIGTERM` antes de abrir
  conexiones, recuerda una señal recibida durante el arranque y evita
  llamadas simultáneas a `close()`; usa `process.exitCode`, sin cortar un
  cierre en curso con `process.exit()`.
- **Logs:** usar un adaptador simple de `console` compatible con
  `OrchestratorLogger`, sin nueva biblioteca. Los mensajes operativos de
  arranque y cierre llevan timestamp ISO y nombre de etapa, nunca URLs ni
  credenciales. Los logs de transición y comandos siguen a cargo de 002.

## Pruebas

- `config.test.ts`: variables obligatorias, valores numéricos válidos e
  inválidos, sin imprimir secretos.
- `bootstrap.test.ts`: fábricas inyectables/fakes para observar el orden de
  creación y cierre, verificar una sola llamada a `startBullWorker`, el
  cierre ante fallo parcial. `main.test.ts` comprueba las señales repetidas
  y los códigos de salida con un proceso falso. Una prueba de 002 comprueba
  la limpieza si falla `orchestrator.start()`. Ninguna de estas pruebas
  envía UDP ni necesita la BD real.
- Verificar `npm run build`, `npm test` y `npm run lint`. Los tests de
  integración existentes de 001/005 siguen usando PostgreSQL local en
  `127.0.0.1:5433` y sus prerequisitos actuales.

## Alternativas descartadas

- **`dotenv` o un runtime TypeScript adicional:** añaden dependencias sin
  aportar una función necesaria; Node y `tsc` existentes cubren el caso.
- **Compartir un único `Pool` con 005:** exigiría cambiar el constructor y
  contrato de otro módulo. Esta iteración usa su API actual y cierra
  explícitamente su `Pool` propio.
- **Duplicar drenaje y pollers en `main.ts`:** 002 ya tiene el contrato y la
  implementación; repetirlo abriría dos ciclos y alteraría el negocio.
- **Prueba de arranque contra hardware real:** puede enviar comandos UDP;
  para 006 basta validar la composición y el ciclo de vida con fakes.

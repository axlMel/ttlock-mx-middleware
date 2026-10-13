# Tasks — 006-app-bootstrap

- [x] Crear `src/app/config.ts`: leer `DATABASE_URL` y `REDIS_URL`, validar
      que no estén vacías y reutilizar `configFromEnv` de 002 para polling y
      reintentos.
- [x] Escribir `src/app/config.test.ts` para configuración válida, ausente e
      inválida, sin exponer secretos en errores ni logs.
- [x] Crear `src/app/bootstrap.ts`: construir `Pool`, Redis, adaptadores reales
      de 001/004/005 y llamar una sola vez a `startBullWorker` con la
      configuración y el protocolo reales; comprobar PostgreSQL y Redis
      antes de iniciar el worker.
- [x] Implementar en `bootstrap.ts` el cierre idempotente y la liberación de
      recursos tras fallo de arranque: worker/cola, directorio, `Pool` y Redis,
      intentando todos los cierres aunque uno falle; desconectar Redis si
      todavía no alcanzó el estado listo.
- [x] Documentar primero en la spec y tasks de 002 y después implementar en
      `startBullWorker` la liberación de su worker, cola y Redis si falla
      `orchestrator.start()` antes de devolver el manejador; probar el caso
      sin alterar jobs ni transiciones.
- [x] Crear `src/app/main.ts`: logs de arranque/apagado con timestamp,
      manejadores `SIGINT`/`SIGTERM`, código de salida correcto y espera del
      cierre sin duplicarlo, incluso si la señal llega durante el arranque.
- [x] Escribir `src/app/bootstrap.test.ts` con fakes para composición,
      arranque único, fallos parciales y orden de cierre; crear
      `src/app/main.test.ts` para señales repetidas y códigos de salida;
      sin conexiones reales ni envíos UDP.
- [x] Añadir `tsconfig.build.json` y los scripts raíz `build`, `dev`,
      `prestart` y `start`; usar `--env-file=.env` en desarrollo, actualizar
      `engines.node` a `>=20.6` en manifest y lockfile, y agregar
      `.env.example` sin secretos.
- [x] Ejecutar `npm run build`, `npm test` y `npm run lint`; confirmar que
      pasan las pruebas nuevas y las existentes de 001 a 005.
- [x] Marcar todas estas tareas como completadas al implementar cada una.

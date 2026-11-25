# Tasks 006 — Arranque de la aplicación

- [x] **T1. Revisión.** Listar lo que ya exista de arranque (`src/`, `package.json`, `.env.example`). Reportarlo. No reutilizar nada de `legacy/`.
- [x] **T2. `loadConfig`.** Todas las variables de la spec, defaults, conversión, reglas de validación y `ConfigError` con la lista completa. Pruebas: defaults, cada regla, varias inválidas a la vez, `ENABLED_COMPANIES` (duplicados, mal formado), booleanos, zona horaria.
- [x] **T3. Secretos.** `secrets.ts`: credenciales de `CREDENTIALS_DIRECTORY`, respaldo en entorno, recorte de espacios, error sin fuentes (sin valores en el mensaje). Pruebas con valores reconocibles.
- [x] **T4. Redacción.** `redactConfig` y prueba de que ni la API key ni la contraseña salen en ninguna cadena registrada.
- [x] **T5. Cableado.** `buildApp` con fábricas inyectables: pool (3 conexiones, 5 s), dos Redis, gateway y auditoría, detectores con `onAlert` → `Logger`, orquestador con el mismo `dryRun`. Pruebas de cada conexión.
- [x] **T6. Arranque.** Orden de la spec, pruebas de PostgreSQL y Redis antes de `orchestrator.start()`, aviso de `CONFIG GET`, `shadow_mode_active`, sin drenaje de historial.
- [x] **T7. Latido.** `heartbeat` cada 60 s con `dryRun` y conteo de rutas por estado; prueba con reloj controlado.
- [x] **T8. Apagado.** `shutdown` en orden (`orchestrator.stop()` con límite de 25 s cierra el `Scheduler`, después Redis y pool, sin doble cierre), segunda señal, errores no capturados. Pruebas con fábricas falsas.
- [x] **T9. `main.ts` y scripts.** Entrada sin lógica; en `package.json`, `build` y `start` (`node dist/main.js`). Sin dependencias nuevas.
- [x] **T10. `.env.example`.** Solo las variables no secretas de `docs/architecture.md` §7; sin `COMMAND_API_KEY`, `DATABASE_URL` ni `REDIS_URL`, con un comentario que indique que los secretos van por credenciales de systemd (spec 008). No editar `AGENTS.md` ni `architecture.md`: listar en el resumen final las líneas que haya que cambiar.
- [x] **T11. Cierre.** `npm run lint`, `npm run build` y `npm test` completos en verde. Fila de 006 en `AGENTS.md` actualizada (solo esa). Commit.
- [x] **T12. Enmienda de REDIS_URL.** Leer `redis-url` desde `CREDENTIALS_DIRECTORY` con respaldo en `REDIS_URL` para desarrollo; validar el esquema, ocultar la URL y su contraseña en configuración, logs y errores, quitarla de `.env.example` y probar precedencia, ausencia y redacción. Commit separado antes de 008.
- [x] **T13. Enmienda de estados.** Quitar `START_MARGIN_MINUTES` de `AppConfig`, validación, `startup_config`, pruebas, cableado de `src/app/` y ejemplo de despliegue; si existe en el entorno, ignorarla sin error.
- [x] **T14. Causa segura de arranque.** Usar `describeError` de `src/common/` en ambos `startup_failed`, conservar `stage` en `buildApp`, omitir `errorMessage` y probar `errorCode: '28P01'` sin mensaje secreto.
- [x] **T15. Configuración de carga.** Sustituir `POLL_INTERVAL_MS_ACK` por `CHAIN_POLL_INTERVAL_MS` y `CHAIN_MAX_QUERIES_PER_SECOND`, usar ACK 150000, validar tasa decimal e ignorar la variable retirada; pruebas de defaults y valores inválidos.
- [x] **T16. Cableado y aviso.** Conectar el limitador de 002 a todas las consultas SQL de tramas, pasar opciones al orquestador, registrar `config_warning` si la ventana ACK es insuficiente y comprobar `startup_config`.
- [x] **T17. Despliegue y cierre.** Actualizar el ejemplo de entorno y referencias de `deploy/`; ejecutar lint, build y tests, revisar referencias restantes y hacer commit sin tocar documentos humanos ni `legacy/`.
- [x] **T18. Partición por calendario.** Eliminar `PARTITION_REFRESH_MS` de configuración y ejemplo; cablear `onPartitionSelected`, registrar el cambio y probar valor antiguo ignorado y ausencia en `startup_config`.

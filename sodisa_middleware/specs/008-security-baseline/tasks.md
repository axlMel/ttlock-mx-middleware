# Tasks 008 — Línea base de seguridad y despliegue

- [x] **T1. Revisión.** Listar lo que ya exista en `deploy/`, `scripts/`, `.gitignore` y los scripts de `package.json`. Reportarlo. No reutilizar nada de `legacy/`.
- [x] **T2. Unidad.** `deploy/gtlock-middleware.service` con todas las directivas de la spec (usuario `gtlock` y tres `LoadCredential`).
- [x] **T3. Variables.** `deploy/gtlock-middleware.env.example` con las variables no secretas de `docs/architecture.md` §7 y sus valores por defecto, `AUDIT_LOG_DIR=/var/lib/gtlock-middleware/audit`, y comentarios que indiquen `ENABLED_COMPANIES=364:2` para pruebas y `364:1` para producción. Sin `COMMAND_API_KEY`, `DATABASE_URL` ni `REDIS_URL`.
- [x] **T4. Valkey.** `deploy/valkey-gtlock.conf` con las cinco directivas de la spec y `include /etc/valkey/gtlock-auth.conf`; la contraseña se crea solo en el servidor.
- [x] **T5. Retención.** `deploy/gtlock-audit.logrotate` según la spec.
- [x] **T6. Empaquetado.** `scripts/package-release.mjs` con la lista cerrada de contenido (función pura, con prueba unitaria), instalación en directorio temporal con `npm ci --omit=dev --omit=optional --ignore-scripts`, falla si hay `*.node`, genera el `.tar.gz` y el `.sha256`, nombre con versión y commit (`-dirty` si hay cambios). Script `npm run package` en `package.json`.
- [x] **T7. `.gitignore`.** Agregar `.env`, `audit/`, `release/`, `*.key`, `credentials/` si faltan.
- [x] **T8. README.** `deploy/README.md` con los pasos 0 a 12 de la spec, comandos exactos, el porqué de cada paso (el lector es la primera vez que despliega), creación de `gtlock-auth.conf` y de `redis-url`, comprobaciones con `valkey-cli --askpass` y la lista de comprobación del modo sombra.
- [x] **T9. Prueba de la unidad.** Verifica las directivas obligatorias (`User=gtlock`, las tres `LoadCredential`, `RestartPreventExitStatus=78`, `TimeoutStopSec` > 25, endurecimiento) y que no hay patrones de secreto en `deploy/`.
- [x] **T10. Auditoría de dependencias.** Ejecutar `npm audit --omit=dev` y reportar el resultado en el resumen. No aplicar correcciones automáticas.
- [x] **T11. Cierre.** `npm run lint`, `npm run build` y `npm test` completos en verde. Fila de 008 en `AGENTS.md` actualizada (solo esa). No editar `docs/` ni el resto de `AGENTS.md`: listar en el resumen lo que yo deba cambiar. Commit.

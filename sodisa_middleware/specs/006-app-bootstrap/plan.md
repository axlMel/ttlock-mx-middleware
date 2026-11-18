# Plan 006 — Arranque de la aplicación

## Decisiones
1. **`loadConfig` es una función pura** (recibe `env` y `readFile`): se prueba sin tocar el entorno ni el disco.
2. **Los secretos tienen dos fuentes con orden fijo:** credenciales de systemd primero, variables de entorno como respaldo para desarrollo. `DATABASE_URL` se trata como secreto porque lleva la contraseña.
3. **Validar todo y reportar todo.** Un error de configuración no se corrige a ciegas: se lista completo para corregirlo de una vez. Salida 78, para que 008 pueda impedir el reinicio automático en ese caso (`RestartPreventExitStatus=78`).
4. **`buildApp` con fábricas inyectables.** Es la forma de probar el cableado (mismo `dryRun`, `onAlert` conectado, orden de cierre) sin Redis ni PostgreSQL.
5. **`main.ts` sin lógica.** Todo lo que merece prueba vive en `src/config/` y `src/app/`.
6. **Errores no capturados terminan el proceso.** El orquestador captura los suyos; lo que escape indica un estado desconocido, y reiniciar es seguro porque todo el estado está en Redis. La política de reinicio es de 008.
7. **Aviso, no error, ante Redis mal configurado.** `appendonly` y `noeviction` son requisitos de despliegue; detenerse por ello contradiría “nunca se detiene”, pero debe ser visible.
8. **Latido en lugar de endpoint de salud**, porque el servicio no abre puertos.
9. **Sin lectura de historial al arrancar.** La recuperación es responsabilidad de `orchestrator.start()`.
10. **Dueño del Scheduler.** `orchestrator.stop()` (002) ya cierra el `Scheduler`; 006 no lo cierra de nuevo. El apagado continúa con Redis y el pool incluso si `stop()` falla o supera 25 s.
11. **Directorio de auditoría.** `loadConfig` solo valida que la ruta no esté vacía. El arranque crea y comprueba que `AUDIT_LOG_DIR` sea escribible antes de abrir PostgreSQL o Redis; un fallo es `ConfigError` (código 78).

## Estructura
```
src/config/
  loadConfig.ts       lectura, conversión y validación; ConfigError
  redact.ts           redactConfig
  secrets.ts          lectura de credenciales con respaldo en entorno
  index.ts
src/app/
  buildApp.ts         cableado, arranque, latido, apagado
  factories.ts        fábricas reales (pg, ioredis, BullMQ)
  index.ts
src/main.ts           entrada: señales, process.env, código de salida
```
Antes de escribir código, el agente revisa si ya existe algo de arranque en `src/` o en `legacy/`, lo reporta y **no reutiliza** código de `legacy/`.

## Orden de trabajo
Revisión de lo existente → `loadConfig` y secretos con pruebas → `redactConfig` → `buildApp` (cableado y arranque) → latido → apagado y señales → `main.ts` y scripts de `package.json` → `.env.example`.

## Riesgos
- BullMQ y el cliente de Redis comparten versión de `ioredis`: usar la que ya trae el proyecto.
- El adaptador de BullMQ y el arranque contra Redis y PostgreSQL reales solo se verifican en el despliegue (sin pruebas locales).
- `CONFIG GET` puede estar deshabilitado en Redis: por eso es aviso.

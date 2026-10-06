# AGENTS.md — gtlock-middleware
 
## Proyecto
Microservicio en Node.js (TypeScript) encargado de la automatización secuencial de geocercas para dispositivos GPS Queclink (**GV300W** y **GV310LAU**). El sistema consume asignaciones de ruta vigentes desde una réplica PostgreSQL de solo lectura (acceso directo, sin capa de API intermedia), envía comandos de configuración de puntos de interés (POI) mediante el protocolo @Track (AT+GTGEO) por UDP a la IP/puerto propios de cada dispositivo, y reacciona en tiempo real ante ACKs y eventos de zona monitoreados por polling administrado sobre el reporte de cadenas, gestionando la progresión de cada dispositivo a través de su ruta mediante una Máquina de Estados Finita (FSM) orquestada con BullMQ.
 
## Metodología: Spec-Driven Development (SDD)
Este proyecto se desarrolla bajo SDD. **Ningún cambio de comportamiento se implementa sin spec previa.**
 
- `docs/constitution.md` — principios no negociables del proyecto. Cambia rara vez y solo por decisión explícita del humano.
- `docs/architecture.md` — contexto operativo vivo (red, credenciales, hallazgos de protocolo por modelo). Se actualiza conforme se confirma información con el equipo.
- `specs/NNN-nombre-feature/spec.md` — QUÉ debe hacer el módulo y POR QUÉ. Sin detalles de implementación. Incluye: entradas, salidas, casos borde, criterios de aceptación.
- `specs/NNN-nombre-feature/plan.md` — CÓMO se implementa: librerías, algoritmos, estructuras de datos, decisiones técnicas y sus alternativas descartadas (con motivo).
- `specs/NNN-nombre-feature/tasks.md` — checklist granular y ejecutable, en orden de implementación, derivado del plan.
**Flujo de trabajo obligatorio para cualquier tarea nueva o modificación:**
1. Verificar si existe spec relevante en `specs/`. Si no existe o está desactualizada, detente y propón (o pide) actualizarla antes de escribir código.
2. Leer `spec.md` → `plan.md` → `tasks.md` del feature correspondiente, en ese orden.
3. Implementar únicamente lo cubierto por `tasks.md`. Si la implementación revela un caso no contemplado en la spec, actualiza la spec primero, luego el código.
4. Marcar la tarea como completada en `tasks.md` en el mismo commit que la implementa.
5. Si `spec.md` y `plan.md` de un mismo módulo contienen contratos técnicos inconsistentes entre sí, gana el documento que contenga la decisión razonada (alternativas evaluadas y descartadas explícitamente) — no automáticamente la spec por jerarquía. Se corrige el otro documento de inmediato y por escrito; nunca se resuelve en silencio dentro del código.
## Especificaciones activas
| ID | Módulo | Estado |
|---|---|---|
| 001 | event-detectors | En diseño — pendiente tabla de asignaciones activas (Paloma) |
| 002 | queue-orchestrator (FSM) | En diseño |
| 003 | queclink-protocol (UDP @Track, multi-modelo) | Implementado |
| 004 | state-persistence (cursor de polling en Redis) | Implementado |
| 005 | device-directory (resolución IMEI → modelo/ip/puerto) | En diseño — simplificado: `resumen_unidad` ya trae modelo |
 
## Comandos
- Ejecutar: `npm run dev` (desarrollo) o `npm start` (producción)
- Tests: `npm test` (Jest/Vitest)
- Lint/formato: `npm run lint` / `npm run format`
- Cola (panel de monitoreo BullMQ, si aplica): `npm run queue:board`
## Dominio: entidades clave
- **Ruta**: asignación vigente de un sitio a un dispositivo. Origen: tabla/vista de asignaciones activas (pendiente de confirmar nombre exacto con Paloma) — **no** es el catálogo de rutas existente.
- **Sitio/POI**: `{ latitud, longitud, radio, orden }`.
- **Dispositivo**: `{ imei, modelo, ip, puerto }` — los cuatro campos se resuelven en una sola consulta a `resumen_unidad` a partir del IMEI. No se requiere heurística de modelo por IMEI/TAC: el modelo viene confirmado en esa misma tabla.
- **RouteState** (persistencia local, NO en la BD externa): `{ deviceId, routeId, currentSiteIndex, fsmState, lastCommandSentAt, retryCount }`, en Redis.
- **PollingCursor** (persistencia local, NO en la BD externa): último `id_report` procesado del reporte de cadenas, en Redis con persistencia (`appendonly yes`) — sobrevive a reinicios del proceso.
## Acceso a datos externos
- Conexión **directa** de solo lectura a PostgreSQL (credenciales provistas por administración de BD). No existe ni se planea una capa de API/microservicio intermedia para esto.
- Toda consulta a BD externa se expone detrás de una interfaz de repositorio (`RouteRepository`, `ChainReportRepository`, `DeviceRepository`) para que la lógica de dominio nunca dependa directamente del driver de BD (principio III de la constitución).
- Paginación sobre `reporte_cadenas` por cursor (`id_report`), guardado en Redis — nunca en una tabla de la BD externa.
## Máquina de estados (FSM) por dispositivo — referencia rápida
`PENDING → CONFIGURING → AWAITING_ACK → IN_ZONE → AWAITING_EXIT_ALERT → (siguiente sitio) PENDING`
 
Al finalizar el último sitio de una ruta, el dispositivo se reconfigura con la geocerca desactivada (`Mode=0`) — ver `specs/003-queclink-protocol/spec.md` para el comando exacto.
 
Detalle completo de transiciones, timeouts y reintentos: ver `specs/002-queue-orchestrator/spec.md`.
 
## Estilo y convenciones
- Node.js 20+, TypeScript estricto (`strict: true`).
- Arquitectura dirigida por eventos (Event-Driven) + FSM explícita, sin lógica de estado implícita en callbacks.
- Identificadores, nombres de funciones, tipos y logs internos en inglés.
- Mensajes de error de usuario/operador, comentarios clave y documentación (specs incluidas) en español.
- Cada módulo (`detectors`, `queue`, `protocol`, `orchestrator`, `persistence`, `device-directory`) vive en su propia carpeta bajo `src/`, con su propia suite de tests unitarios.
## Reglas (constitución)
- Lee `docs/constitution.md`, `docs/architecture.md` y la spec técnica activa en `specs/` antes de escribir o modificar código.
- No abras sockets de escucha UDP directos para el hardware; la comunicación saliente de comandos se realiza estrictamente hacia la IP/puerto propios de cada dispositivo, resueltos vía `resumen_unidad`.
- La base de datos externa (PostgreSQL) es de **SOLO LECTURA**. Queda estrictamente prohibido intentar INSERT/UPDATE/DELETE sobre ella. Todo el estado local (FSM, cursor de polling, reintentos) se gestiona en Redis — nunca en la BD externa.
- El polling a la BD externa debe ser administrado: intervalos configurables por variable de entorno, backoff en ausencia de resultados, y logging de cada ciclo.
- Todo comando UDP enviado y todo estado de FSM debe quedar loggeado con timestamp, deviceId y routeId para trazabilidad y debugging de campo. Esta responsabilidad vive en el orquestador (`specs/002`), que ya tiene ese contexto disponible en `RouteState` al momento de invocar el envío — `sendGeoCommand` (`specs/003`) mantiene su firma técnica de tres argumentos (`host, port, command`) y no necesita conocer deviceId ni routeId para su propio trabajo.
- No modifiques archivos dentro de `specs/` ni añadas dependencias npm sin actualizar primero la spec correspondiente, o bajo petición explícita del humano.
- Ningún módulo debe importar directamente de otro salvo a través de las interfaces/contratos definidos en su `spec.md` (evita acoplamiento implícito entre detectores, cola y protocolo).
- El puerto de escucha de un dispositivo **no es una constante fija por modelo en el código** — siempre se toma del valor devuelto por `resumen_unidad` para ese IMEI, aunque en la práctica coincida con el puerto típico de su modelo.
## Variables de entorno esperadas
```
DATABASE_URL=
REDIS_URL=
POLL_INTERVAL_MS_ROUTES=
POLL_INTERVAL_MS_ACK=
POLL_INTERVAL_MS_ALERTS=
ACK_MAX_RETRIES=
ACK_RETRY_BACKOFF_MS=
```
(No hay variables de host/puerto de destino UDP: se resuelven por dispositivo desde `resumen_unidad`, no por configuración de entorno.)
 
## Configuración base del repositorio
El tooling de proyecto (`package.json`, `tsconfig.json` en modo estricto,
configuración de Jest y de ESLint) vive en la **raíz del repositorio**, no
dentro de la carpeta de un módulo. Se crea **una sola vez**, como parte de
la primera iteración de código (la de `specs/003`), y los módulos
posteriores (004, 002, etc.) la reutilizan tal cual — ninguno crea su
propio `package.json` ni su propia configuración de Jest/ESLint. Si algún
agente propone crear esta configuración "limitada" a un módulo específico,
corresponde corregirlo antes de continuar: es deuda técnica inmediata que
se vuelve más cara de deshacer con cada módulo adicional que se agregue.
 
## Al terminar cualquier tarea
- Ejecuta `npm test` y verifica que el linter no devuelva errores.
- Confirma explícitamente en tu respuesta que todas las pruebas automatizadas pasan correctamente.
- Si la tarea correspondía a un ítem de `specs/*/tasks.md`, márcalo como completado en ese archivo.
- Si se descubrió un caso borde no contemplado, documéntalo en el `spec.md` correspondiente antes de cerrar la tarea.
 

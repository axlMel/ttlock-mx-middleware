# AGENTS.md — gtlock-middleware

## Proyecto
Microservicio en Node.js (TypeScript) que automatiza la configuración secuencial de geocercas en equipos GPS Queclink (**GV300W** y **GV310LAU**). Lee de la BD de GlobalTrack (solo lectura) las asignaciones de viaje vigentes de las empresas habilitadas, resuelve su ruta con coordenadas y radio, y configura un punto a la vez en el equipo enviando `AT+GTGEO` **por la API de comandos**. Confirma cada configuración y cada salida de zona leyendo las tramas de `tbl_cadena`, y avanza al siguiente punto. Una máquina de estados explícita (FSM) orquestada con BullMQ gobierna cada ruta. La v1 atiende rutas con orden (`int_tipo = 0`).

## Documentos
- `docs/constitution.md` — principios innegociables. Cambia rara vez y solo por decisión humana.
- `docs/architecture.md` — hechos del entorno real y decisiones de arquitectura (BD, API, particiones, configuración, fases de despliegue).
- `specs/NNN-nombre/` — una carpeta por módulo con tres archivos: `spec.md` (QUÉ y POR QUÉ), `plan.md` (CÓMO, con alternativas descartadas) y `tasks.md` (checklist ejecutable).

**Administración humana:** `docs/constitution.md`, `docs/architecture.md` y este archivo los administra una persona. No los modifiques; la única excepción es la fila de estado de tu spec en la tabla de abajo.

## Metodología: Spec-Driven Development (SDD)
**Ningún cambio de comportamiento se implementa sin spec previa.**

Flujo obligatorio para cualquier tarea nueva o modificación:
1. Verificar si existe spec relevante en `specs/`. Si no existe o está desactualizada, detente y propón (o pide) actualizarla antes de escribir código.
2. Leer `spec.md` → `plan.md` → `tasks.md` del módulo, en ese orden.
3. Implementar únicamente lo cubierto por `tasks.md`. Si la implementación revela un caso no contemplado, actualiza la spec primero, luego el código.
4. Marcar la tarea como completada en `tasks.md` en el mismo commit que la implementa.
5. Si `spec.md` y `plan.md` de un mismo módulo contienen contratos técnicos inconsistentes, gana el documento que contenga la decisión razonada (alternativas evaluadas y descartadas explícitamente). Se corrige el otro documento de inmediato y por escrito; nunca se resuelve en silencio dentro del código.

## Especificaciones activas
| ID | Módulo | Estado |
|---|---|---|
| 001 | event-detectors (asignaciones vigentes y tramas por equipo) | Implementado |
| 002 | queue-orchestrator (FSM) | Reescritura pendiente (tanda 3) |
| 003 | queclink-protocol (comandos y parseo) | Implementado |
| 004 | state-persistence (estado, cursores y caché en Redis) | Implementado |
| 005 | device-directory (catálogo local: unidad, dispositivo y plan de ruta) | Implementado |
| 006 | app-bootstrap | Enmienda pendiente (tanda 3) |
| 007 | command-gateway (API de comandos y auditoría) | Implementado |
| 008 | security-baseline | Pendiente |
| 009 | unordered-routes (rutas desordenadas) | Planificada, fuera de la v1 |

## Comandos
- Ejecutar: `npm run dev` (desarrollo) o `npm start` (producción).
- Tests: `npm test`. No requiere red, BD, Redis ni Docker: usa clientes falsos y datos de ejemplo reales.
- Lint y formato: `npm run lint` / `npm run format`.

## Dominio: entidades clave
- **Asignación** (`catalogos.tbl_asignacion_viaje`): vigente ⇔ `int_estado = 1` y `bol_enuso`. Su `int_id` es el `routeId` de logs y auditoría.
- **Ruta y puntos:** `int_idruta` lleva a `catalogos.tbl_punto_ruta` (orden por `int_orden`). `catalogos.tbl_ruta.int_tipo`: `0` con orden (v1), `1` desordenada (se omite con alerta).
- **Sitio** (`catalogos_gis.tbl_sitio`): coordenadas (`g_posicion`) y radio (`int_radio`, metros; mínimo 50).
- **Unidad → dispositivo → modelo:** `tbl_unidad`, `tbl_dispositivo`, modelo `25` = GV300W y `100` = GV310LAU (mapa estático).
- **RouteState, ChainCursor y caché de catálogo:** estado propio en Redis (spec 004), nunca en la BD externa.

## Máquina de estados (FSM) por asignación — referencia rápida
`PENDING → CONFIGURING → AWAITING_ACK → IN_ZONE → AWAITING_EXIT_ALERT → (siguiente punto) PENDING → … → paso de reset → COMPLETED`

No existe `FAILED` ni pausa para operador: los reintentos de ACK son continuos. Si la asignación deja de ser vigente, la ruta se cierra con un reset. Detalle en `specs/002-queue-orchestrator/spec.md`.

## Estilo y convenciones
- Node.js 20+, TypeScript estricto (`strict: true`).
- Arquitectura dirigida por eventos + FSM explícita, sin lógica de estado implícita en callbacks.
- Identificadores, nombres de funciones, tipos y logs internos en inglés. Mensajes de error visibles, comentarios clave y documentación en español.
- Cada módulo vive en su carpeta bajo `src/` (`event-detectors`, `orchestrator`, `protocol`, `persistence`, `device-directory`, `command-gateway`, `app`) con sus propias pruebas.
- `legacy/` contiene código antiguo estacionado durante la transición: no se modifica, no se importa y está fuera de `tsconfig` y de las pruebas. Se elimina al cerrar la tanda 3.

## Reglas (constitución aplicada)
- Lee `docs/constitution.md`, `docs/architecture.md` y la spec activa antes de escribir o modificar código.
- **Datos externos:** solo lectura. Sin JOINs ni `SELECT *`. Solo llaves primarias e índices existentes. Consultas parametrizadas. El nombre de la partición de `tbl_cadena` se acepta solo si viene del catálogo y cumple `^[0-9]{6}$`. Todo el estado propio vive en Redis.
- **Red:** solo salidas. El middleware no abre sockets ni escucha en ningún puerto. Los comandos a los equipos salen únicamente por la API de comandos (spec 007).
- **Comandos:** se validan antes de armarse (spec 003) y se registran en la auditoría **antes** de enviarse; si la auditoría falla, no se envía. Nunca se crea una `Idempotency-Key` nueva para reintentar una petición de resultado incierto. Retransmitir por falta de ACK solo con clave nueva y la política de la spec 002. `COMMAND_DRY_RUN=true` ejecuta todo sin llamar a la API.
- **Secretos:** `COMMAND_API_KEY` nunca aparece en el repositorio, en logs ni en la auditoría.
- **Trazabilidad:** todo comando y todo cambio de estado se registra con `timestamp`, `deviceId` y `routeId`.
- No modifiques archivos dentro de `specs/` ni añadas dependencias npm sin actualizar primero la spec o el plan correspondiente, o sin petición explícita del humano.
- Ningún módulo importa de otro salvo a través de las interfaces definidas en su `spec.md`.

## Configuración base del repositorio
El tooling (`package.json`, `tsconfig.json` estricto, Jest y ESLint) vive en la **raíz** del repositorio y lo reutilizan todos los módulos; ninguno crea el suyo. Si un agente propone configuración limitada a un módulo, corrígelo antes de continuar.

## Variables de entorno esperadas
Los valores por defecto y su significado están en `docs/architecture.md` §7.
```
DATABASE_URL=
REDIS_URL=
ENABLED_COMPANIES=            # pares plataforma:api, ej. 364:2 (pruebas) o 364:1 (producción)
ASSIGNMENT_TZ=UTC
START_MARGIN_MINUTES=15
POLL_INTERVAL_MS_ROUTES=10000
POLL_INTERVAL_MS_ACK=3000
ACK_RETRY_BACKOFF_MS=60000
ACK_MAX_RETRIES=3
ACK_RESEND_ENABLED=true
CATALOG_REVALIDATE_MS=300000
CHAIN_BATCH_LIMIT=500
CHAIN_OVERLAP_MS=10000
PARTITION_REFRESH_MS=600000
COMMAND_API_URL=
COMMAND_API_KEY=              # secreto
COMMAND_API_TIMEOUT_MS=10000
COMMAND_DRY_RUN=false
AUDIT_LOG_DIR=./audit
```

## Al terminar cualquier tarea
- Ejecuta `npm test` y `npm run lint`, y confirma explícitamente que pasan.
- Marca el ítem en `tasks.md` y actualiza la fila de estado de tu spec en la tabla de arriba.
- Si se descubrió un caso borde no contemplado, documéntalo en el `spec.md` antes de cerrar la tarea.

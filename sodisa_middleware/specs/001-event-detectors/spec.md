# Spec 001 — Detectores (asignaciones vigentes y tramas del equipo)

> Carpeta `specs/001-event-detectors`; código en `src/detectors/`.

## Objetivo
Exponer dos fuentes de datos de la BD de GlobalTrack: las asignaciones vigentes y las tramas nuevas
de un equipo. Son consultas puntuales; el orquestador decide cuándo y con qué frecuencia llamarlas.

## Fuera de alcance
- Decisión sobre cada evento → `specs/002`. Interpretación de tramas → `specs/003` (aquí solo se entregan `Buffer`).
- Unidad, dispositivo y plan de ruta → `specs/005`. Persistencia del cursor → `specs/004`.
- Creación del pool (máx. 3 conexiones, `statement_timeout` 5 s) y lectura de variables de entorno → arranque (`specs/006`). Aquí se **recibe** un cliente y opciones.

## Interfaces
```typescript
// src/db/types.ts  (compartido; 005 pasa a importarlo de aquí)
interface SqlClient { query(text: string, values: unknown[]): Promise<{ rows: Record<string, unknown>[] }>; }

interface AssignmentRow {
  assignmentId: number; companyId: number; unitId: number; catalogRouteId: number;
  estado: number; enUso: boolean;
  horaInicial: Date; horaFinal: Date | null; // hora final real, nula mientras no termina; interpretadas en assignmentTz
  modificadoEn: string | null;             // texto tal cual lo entrega la BD
}
interface AssignmentDetector {
  listVigentes(companyId: number): Promise<AssignmentRow[]>;
  getById(assignmentId: number): Promise<AssignmentRow | null>;
}

interface ChainFrame { frameId: number; deviceId: number; receivedAt: string; raw: Buffer }
interface ChainAlert { code: 'PARTITION_UNREADABLE' | 'PARTITION_NOT_FOUND' | 'CHAIN_WINDOW_SATURATED'; partition: string; message: string }
interface ChainReader {
  initCursor(deviceId: number): Promise<ChainCursor>;
  readNew(deviceId: number, cursor: ChainCursor): Promise<{ frames: ChainFrame[]; cursor: ChainCursor; hasMore: boolean }>;
}

interface DetectorOptions {
  assignmentTz: string;        // ASSIGNMENT_TZ
  chainBatchLimit: number;     // CHAIN_BATCH_LIMIT
  chainOverlapMs: number;      // CHAIN_OVERLAP_MS
  now?: () => number;          // reloj inyectable
  onAlert?: (alert: ChainAlert) => void;
  onPartitionSelected?: (event: { partition: string; computed: string; fallback: boolean }) => void;
}
function createAssignmentDetector(db: SqlClient, opts: Pick<DetectorOptions,'assignmentTz'>): AssignmentDetector;
function createChainReader(db: SqlClient, opts: DetectorOptions): ChainReader;
function weekLabel(ms: number): string;
function weekStartMs(label: string): number;
function previousLabel(label: string): string;
const VIGENT_STATES: readonly [3, 4];
function isActiveAssignment(row: AssignmentRow): boolean; // row.enUso && VIGENT_STATES.includes(row.estado)
```
`ChainCursor` está definido en `specs/004`. Todo se exporta desde `src/detectors/index.ts`; es lo único que otros módulos pueden importar.

## Consultas autorizadas
```sql
-- A1. Asignaciones vigentes de una empresa (índice empresa_por_estado4)
SELECT int_id, int_idempresa, int_idunidad, int_idruta, int_estado, bol_enuso,
       dt_hora_inicial AT TIME ZONE $2 AS dt_hora_inicial,
       dt_hora_final   AT TIME ZONE $2 AS dt_hora_final,
       dt_modificacion::text AS dt_modificacion
FROM catalogos.tbl_asignacion_viaje
WHERE int_idempresa = $1 AND int_estado IN (3, 4) AND bol_enuso;

-- A2. Una asignación por llave primaria (mismas columnas)
SELECT int_id, int_idempresa, int_idunidad, int_idruta, int_estado, bol_enuso,
       dt_hora_inicial AT TIME ZONE $2 AS dt_hora_inicial,
       dt_hora_final   AT TIME ZONE $2 AS dt_hora_final,
       dt_modificacion::text AS dt_modificacion
FROM catalogos.tbl_asignacion_viaje WHERE int_id = $1;

-- C0. Última trama del equipo en la partición (índice idx_dispositivo_fecha)
SELECT max(dt_trama)::text AS ultima FROM tbl_cadena."<partición>" WHERE int_iddispositivo = $1;
-- C0b. Ids dentro de la ventana de solapamiento
SELECT int_id FROM tbl_cadena."<partición>"
WHERE int_iddispositivo = $1 AND dt_trama >= $2::timestamp - $3 * interval '1 millisecond';

-- C1. Tramas nuevas de un equipo
SELECT int_id, dt_trama::text AS dt_trama, bytea_mensaje FROM tbl_cadena."<partición>"
WHERE int_iddispositivo = $1 AND dt_trama >= $2::timestamp - $3 * interval '1 millisecond'
ORDER BY dt_trama LIMIT $4;
-- C1b. Igual, sin la condición de tiempo, cuando el cursor está en null
SELECT int_id, dt_trama::text AS dt_trama, bytea_mensaje FROM tbl_cadena."<partición>"
WHERE int_iddispositivo = $1 ORDER BY dt_trama LIMIT $2;

-- P0. Verificación de particiones (catálogo, sin JOIN). Solo cuando el nombre calculado no está en la última lista.
SELECT oid FROM pg_namespace WHERE nspname = 'tbl_cadena';
SELECT relname FROM pg_class
WHERE relnamespace = $1 AND relkind IN ('r','p') AND relname ~ '^[0-9]{6}$'
ORDER BY relname DESC;
```
`$2` de A1/A2 es `assignmentTz`. `$3` de C0b/C1 es `chainOverlapMs`; `$4` de C1 es `chainBatchLimit`.
El nombre de partición se calcula con `weekLabel` (sección «Tramas»), cumple `^[0-9]{6}$`, se usa solo si aparece en P0 (o es el respaldo tomado de P0) y se cita como identificador; nunca se concatena texto externo.
Las columnas `dt_hora_inicial`, `dt_hora_final`, `dt_modificacion` y `dt_trama` son `timestamp without time zone`: `AT TIME ZONE` las interpreta en `assignmentTz` y `::text` conserva la precisión completa. No se configura ningún parser global de tipos de `pg`.

## Reglas
**Asignaciones**
- `listVigentes` solo devuelve filas con `int_estado` 3 o 4 y `bol_enuso` (ver sección “Estados”). Las filas en estado 1 no se devuelven. `getById` devuelve la fila sea cual sea su estado; `null` si no existe.
- `int_id`, `int_idempresa`, `int_idunidad`, `int_idruta` y `int_estado` se convierten con `Number()` y se validan como enteros finitos; una fila inválida lanza un error con su `int_id`.
- `dt_hora_final` es la hora real de término y solo informativa: se conserva como `null` si la BD devuelve `NULL` (sin convertirla a 1970); `AT TIME ZONE` sobre `NULL` también devuelve `NULL`.

## Estados
| Valor | Nombre | Significado | Tratamiento |
|---|---|---|---|
| -1 | CanceladoEDI | Cancelado por integración | Nunca vigente |
| 0 | SinAsignar | Sin unidad asignada | Nunca vigente |
| 1 | Asignada | Con unidad asignada, aún no es hora de salir | Espera: no se consulta posición ni se configura |
| 2 | Cumplida | Terminada normalmente por el sistema | Deja de ser vigente |
| 3 | ATiempo | A tiempo de salir para la unidad | Vigente |
| 4 | Tarde | Unidad retrasada, lista para salir | Vigente |
| 5 | Cancelado | Terminada por el usuario | Deja de ser vigente |
| 6 | Incumplida | Terminada por el usuario | Deja de ser vigente |
| 7 | Terminar | ElevenMinds no lo usa ni lo documenta | Deja de ser vigente |

Vigente ⇔ `isActiveAssignment(row)`: `row.enUso && VIGENT_STATES.includes(row.estado)`.
Una asignación puede aparecer directamente en estado 4.

**Tramas**
- Un `ChainReader` por proceso. Se consulta **un equipo por llamada**; el orquestador las encadena de forma secuencial.
- `weekLabel(ms)` usa año y día del año UTC: `floor((dayOfYear - 1) / 7) + 1`, con semana 01 desde el 1 de enero. `weekStartMs(label) = Date.UTC(year, 0, 1) + (week - 1) * 7 * 86400000`; `previousLabel(label) = weekLabel(weekStartMs(label) - 1)`. No es semana ISO. La semana 53 dura uno o dos días.

| Fecha UTC | Etiqueta |
|---|---|
| 2025-12-10 | `202550` |
| 2025-12-31 | `202553` |
| 2026-01-01 | `202601` |
| 2026-11-05 | `202645` |
| 2026-11-19 y 2026-11-24 | `202647` |
| 2026-11-26 | `202648` |
| 2026-12-31 | `202653` |
| 2027-01-01 | `202701` |
| 2028-12-29 | `202852` |
| 2028-12-30 y 2028-12-31 | `202853` |
| 2030-12-31 | `203053` |
| 2031-01-01 | `203101` |

- `resolveCurrent(nowMs)` comparte una lista `known` de P0 por proceso, el OID del esquema, `lastCheckAt` y una única ejecución P0 en vuelo. Si la etiqueta calculada está en `known`, no consulta P0. Si falta, consulta P0 una vez al inicio y luego como máximo una vez cada 60 s (`PARTITION_RECHECK_MS`, constante interna). Una etiqueta ausente genera `PARTITION_NOT_FOUND` una vez y usa la mayor partición conocida menor; sin respaldo lanza error. Sin equipos que leer no se consulta P0 ni hay temporizador. Se descartan nombres que no cumplen `^[0-9]{6}$`.
- `onPartitionSelected` informa `{ partition, computed, fallback }` tras la primera selección efectiva y cada cambio de partición, nunca por cada equipo o sondeo. El respaldo por etiqueta ausente o por `42501` se registra como `fallback: true`.
- `readNew` lanza `PartitionNotKnownError` cuando una marca heredada apunta a un nombre que no está en P0; 002 puede entonces reiniciar el cursor sin confundir ese caso con un fallo de BD.
- `initCursor` resuelve la partición actual y usa C0/C0b solo en ella. Si falla con `42501`, avisa una vez por partición e intenta en orden las particiones conocidas anteriores hasta encontrar una legible; otros errores se propagan. Sin tramas devuelve `dtTrama: null`, no cambia de partición ni crea `previous`.
- `readNew` usa marcas independientes por partición (spec 004). Si `cursor.partition < P` y su `dtTrama` no es nulo, lee primero esa partición y luego `P`, y crea `previous` desde la marca antigua. Si la marca antigua es nula, consulta solo `P`: C1b sobre la anterior entregaría historial y podría confundir un ACK viejo. Si `cursor.partition === P`, solo lee la anterior dentro de los primeros cinco minutos (`PARTITION_DUAL_READ_MS = 300000`) cuando `previous` ya existe y corresponde a `previousLabel(P)`; la marca anterior no nula evita leer historial aunque la marca actual sea nula. `previous` **nunca** nace de un `initCursor` en la semana actual. Un lote anterior lleno continúa drenándose aunque termine la ventana; fuera de ella se retira `previous` al agotarse. Si `cursor.partition > P`, lee esa partición; 002 repara antes los cursores futuros heredados.
- Cada lectura usa C1 con su propia marca de tiempo, o C1b si esa marca es nula. Se combinan filas ordenadas por `dt_trama` y luego `int_id`, se eliminan los `int_id` ya vistos y las repeticiones entre lecturas. Cada marca avanza solo con las filas de su partición: `dtTrama` es su mayor hora y `recentIds` conserva los ids de la ventana de `chainOverlapMs`, incluidos los descartados. `hasMore` es verdadero si alguna lectura llega a `chainBatchLimit`. Un lote lleno solo de duplicados emite `CHAIN_WINDOW_SATURATED` por lectura. Así una partición no adelanta la marca de la otra.
- Si leer `P` falla con `42501` durante el cambio de semana, se avisa una vez y se conserva solo la lectura y la marca de la partición del cursor. Si el cursor ya está en `P`, el error se propaga tras alertar: no se retrocede el cursor ni se pierde su marca. Otros errores se propagan. Todas las consultas a `tbl_cadena` pasan por el limitador de 002.
- Limitación documentada: no se lee una inserción en la partición anterior hecha más de cinco minutos después del corte, salvo que aún se esté drenando un lote anterior pendiente. El solapamiento de 10 s sigue delimitando el reordenamiento de horas dentro de cada partición.
- `bytea_mensaje` se entrega como `Buffer`; no se usa `encode()` en SQL.

**Generales**
- Consultas parametrizadas, sin JOINs ni `SELECT *`. Ninguna escritura en la BD.

## Criterios de aceptación
- [ ] Una fila con `dt_hora_final` nula devuelve `horaFinal: null` sin lanzar; con valor devuelve el `Date` correcto.
- [ ] `listVigentes` usa el filtro `int_estado IN (3, 4) AND bol_enuso` (prueba sobre el texto de A1) y `isActiveAssignment` da verdadero solo para 3 y 4 con `enUso`, y falso para −1, 0, 1, 2, 5, 6, 7 y cualquier fila con `enUso = false`.
- [ ] `VIGENT_STATES` coincide con la lista literal de A1 (prueba que extrae `IN (…)` del SQL y lo compara).
- [ ] `listVigentes` devuelve filas tipadas y pasa `assignmentTz` como `$2`; el `Date` resultante corresponde a esa zona (prueba con una zona distinta de UTC).
- [ ] `getById` devuelve una asignación no vigente y `null` si no existe. Una fila con id no numérico lanza error.
- [ ] `weekLabel` coincide con toda la tabla de fechas y `previousLabel('202601') = '202553'`, `previousLabel('202647') = '202646'`, `previousLabel('202701') = '202653'`.
- [ ] Entre 2025 y 2035 las etiquetas no decrecen, cambian a la semana siguiente o al 01 del año siguiente; `weekStartMs(weekLabel(x)) <= x` y `weekLabel(weekStartMs(L)) = L`. Las semanas 01–52 duran siete días y la 53 uno o dos.
- [ ] Con catálogo `202646`–`202651` y fecha 2026-11-24, `initCursor` consulta solo `202647`, incluso con varios equipos; P0 se ejecuta una sola vez y no contiene `LIMIT`.
- [ ] Si falta la etiqueta actual, `PARTITION_NOT_FOUND` aparece una vez y se usa la mayor anterior; P0 se repite como máximo una vez por minuto y adopta la nueva etiqueta cuando aparece. Los nombres inválidos se descartan.
- [ ] Un equipo sin tramas devuelve `dtTrama: null` y lecturas vacías sin cambiar partición ni emitir alertas. `42501` en `initCursor` usa la anterior legible y alerta una vez.
- [ ] `readNew` no devuelve dos veces una trama ya vista (solapamiento y deduplicación) y avanza el cursor; `recentIds` conserva los ids de la ventana, incluidos los descartados.
- [ ] La comparación de ventana respeta microsegundos (dos tramas a 1 µs de distancia).
- [ ] `hasMore` es verdadero cuando se alcanza el límite; `CHAIN_WINDOW_SATURATED` cuando todas son duplicadas.
- [ ] En el cambio `202647` → `202648`, y `202653` → `202701` o `202553` → `202601`, se leen ambas particiones en orden; sus marcas avanzan por separado sin perder filas por un lote lleno.
- [ ] En los primeros cuatro minutos, con marca anterior heredada del cambio, se leen ambas particiones; a los seis minutos solo la actual tras drenar. `initCursor` dentro de la ventana no crea `previous` ni entrega historial antiguo, aunque la partición actual tenga tramas.
- [ ] `42501` en la partición nueva alerta una vez y conserva la lectura de la partición del cursor; `onPartitionSelected` se invoca en la primera selección efectiva y en cada cambio, no por llamada.
- [ ] Un nombre de partición que no cumple `^[0-9]{6}$` se rechaza.
- [ ] `raw` llega como `Buffer` y se puede pasar a `decodeFrame` de `specs/003`.
- [ ] Ninguna consulta contiene `JOIN` ni `SELECT *` (prueba sobre las cadenas SQL).
- [ ] Las pruebas usan un `SqlClient` falso con filas reales como fixtures; no hay BD local.

## Fuera de alcance de esta iteración
- Índices nuevos o consultas por arreglo (`ANY`) de dispositivos.
- Lectura de más de una partición anterior.

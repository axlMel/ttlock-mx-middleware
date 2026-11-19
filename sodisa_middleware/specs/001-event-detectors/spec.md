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
  horaInicial: Date; horaFinal: Date;      // interpretadas en assignmentTz
  modificadoEn: string | null;             // texto tal cual lo entrega la BD
}
interface AssignmentDetector {
  listVigentes(companyId: number): Promise<AssignmentRow[]>;
  getById(assignmentId: number): Promise<AssignmentRow | null>;
}

interface ChainFrame { frameId: number; deviceId: number; receivedAt: string; raw: Buffer }
interface ChainAlert { code: 'PARTITION_UNREADABLE' | 'PARTITION_DISAPPEARED' | 'CHAIN_WINDOW_SATURATED'; partition: string; message: string }
interface ChainReader {
  initCursor(deviceId: number): Promise<ChainCursor>;
  readNew(deviceId: number, cursor: ChainCursor): Promise<{ frames: ChainFrame[]; cursor: ChainCursor; hasMore: boolean }>;
}

interface DetectorOptions {
  assignmentTz: string;        // ASSIGNMENT_TZ
  chainBatchLimit: number;     // CHAIN_BATCH_LIMIT
  chainOverlapMs: number;      // CHAIN_OVERLAP_MS
  partitionRefreshMs: number;  // PARTITION_REFRESH_MS
  now?: () => number;          // reloj inyectable
  onAlert?: (alert: ChainAlert) => void;
}
function createAssignmentDetector(db: SqlClient, opts: Pick<DetectorOptions,'assignmentTz'>): AssignmentDetector;
function createChainReader(db: SqlClient, opts: DetectorOptions): ChainReader;
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

-- P0. Descubrimiento de particiones (catálogo, sin JOIN)
SELECT oid FROM pg_namespace WHERE nspname = 'tbl_cadena';
SELECT relname FROM pg_class
WHERE relnamespace = $1 AND relkind IN ('r','p') AND relname ~ '^[0-9]{6}$'
ORDER BY relname DESC LIMIT 2;
```
`$2` de A1/A2 es `assignmentTz`. `$3` de C0b/C1 es `chainOverlapMs`; `$4` de C1 es `chainBatchLimit`.
El nombre de partición solo se acepta si viene de P0 y cumple `^[0-9]{6}$`; se cita como identificador y nunca se concatena texto externo.
Las columnas `dt_hora_inicial`, `dt_hora_final`, `dt_modificacion` y `dt_trama` son `timestamp without time zone`: `AT TIME ZONE` las interpreta en `assignmentTz` y `::text` conserva la precisión completa. No se configura ningún parser global de tipos de `pg`.

## Reglas
**Asignaciones**
- `listVigentes` solo devuelve filas con `int_estado` 3 o 4 y `bol_enuso` (ver sección “Estados”). Las filas en estado 1 no se devuelven. `getById` devuelve la fila sea cual sea su estado; `null` si no existe.
- `int_id`, `int_idempresa`, `int_idunidad`, `int_idruta` y `int_estado` se convierten con `Number()` y se validan como enteros finitos; una fila inválida lanza un error con su `int_id`.

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
- “Partición actual” = la más nueva de P0 que sea legible. Una partición es **no legible** cuando la consulta falla con el código `42501` (permiso denegado: el acceso se otorga por partición). Cualquier otro error se propaga.
- `initCursor`: C0 y C0b en la partición actual. Sin tramas → `{ partition, dtTrama: null, recentIds: [] }`. Si ninguna de las dos particiones es legible, lanza error.
- `readNew`: C1 (o C1b si `dtTrama` es null) en `cursor.partition`. Descarta filas cuyo `int_id` esté en `recentIds`. El nuevo `dtTrama` es el mayor de todas las filas devueltas. Los nuevos `recentIds` son los ids de **todas** las filas devueltas (también las descartadas) cuyo `dt_trama` esté dentro de `chainOverlapMs` del nuevo `dtTrama`; la comparación usa microsegundos enteros (sin pasar por `Date`). `hasMore` es verdadero si la consulta devolvió `chainBatchLimit` filas.
- Si la consulta devolvió `chainBatchLimit` filas y todas eran duplicadas (el cursor no puede avanzar), se emite `CHAIN_WINDOW_SATURATED`.
- **Cambio de partición:** si la actual no devuelve filas y existe una partición más nueva, se consulta esa con C1b. Si es legible, el cursor pasa a ella con `dtTrama` de su última fila. Si no es legible (`42501`), se sigue en la actual y se emite `PARTITION_UNREADABLE` (una sola vez por partición mientras siga sin permiso).
- Limitación documentada: una trama que llegara a la partición anterior después de pasar a la nueva no se lee.
- `bytea_mensaje` se entrega como `Buffer`; no se usa `encode()` en SQL.
- P0 al arrancar y cada `partitionRefreshMs`. Si una partición presente en el descubrimiento anterior ya no aparece, se emite `PARTITION_DISAPPEARED`.

**Generales**
- Consultas parametrizadas, sin JOINs ni `SELECT *`. Ninguna escritura en la BD.

## Criterios de aceptación
- [ ] `listVigentes` usa el filtro `int_estado IN (3, 4) AND bol_enuso` (prueba sobre el texto de A1) y `isActiveAssignment` da verdadero solo para 3 y 4 con `enUso`, y falso para −1, 0, 1, 2, 5, 6, 7 y cualquier fila con `enUso = false`.
- [ ] `VIGENT_STATES` coincide con la lista literal de A1 (prueba que extrae `IN (…)` del SQL y lo compara).
- [ ] `listVigentes` devuelve filas tipadas y pasa `assignmentTz` como `$2`; el `Date` resultante corresponde a esa zona (prueba con una zona distinta de UTC).
- [ ] `getById` devuelve una asignación no vigente y `null` si no existe. Una fila con id no numérico lanza error.
- [ ] `initCursor` devuelve el cursor con ids de la ventana; sin tramas devuelve `dtTrama: null`; con la partición más nueva sin permiso usa la anterior y emite alerta.
- [ ] `readNew` no devuelve dos veces una trama ya vista (solapamiento y deduplicación) y avanza el cursor; `recentIds` conserva los ids de la ventana, incluidos los descartados.
- [ ] La comparación de ventana respeta microsegundos (dos tramas a 1 µs de distancia).
- [ ] `hasMore` es verdadero cuando se alcanza el límite; `CHAIN_WINDOW_SATURATED` cuando todas son duplicadas.
- [ ] Cambio de partición: se agota la actual y luego se pasa a la nueva; si la nueva da `42501`, sigue en la actual con una sola alerta.
- [ ] `PARTITION_DISAPPEARED` cuando una partición deja de aparecer en P0.
- [ ] Un nombre de partición que no cumple `^[0-9]{6}$` se rechaza.
- [ ] `raw` llega como `Buffer` y se puede pasar a `decodeFrame` de `specs/003`.
- [ ] Ninguna consulta contiene `JOIN` ni `SELECT *` (prueba sobre las cadenas SQL).
- [ ] Las pruebas usan un `SqlClient` falso con filas reales como fixtures; no hay BD local.

## Fuera de alcance de esta iteración
- Índices nuevos o consultas por arreglo (`ANY`) de dispositivos.
- Lectura de más de una partición anterior.

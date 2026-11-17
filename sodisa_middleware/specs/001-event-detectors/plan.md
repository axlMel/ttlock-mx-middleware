# Plan 001 — Detectores

## Decisiones
1. **`SqlClient` compartido en `src/db/types.ts`.** 005 lo definió dentro de `src/catalog/`; se mueve a un lugar neutro y `catalog` lo importa de allí (cambio de una línea de import; sin cambio de comportamiento).
2. **Zona y precisión resueltas en SQL.** `AT TIME ZONE $2` y `::text` evitan parsers globales de `pg` que afectarían a otros módulos y no requieren librerías de zonas horarias.
3. **Microsegundos enteros.** `micros.ts` convierte el texto `YYYY-MM-DD HH:MM:SS[.ffffff]` a `bigint` de microsegundos para comparar la ventana sin pérdida de precisión; sin dependencias.
4. **Particiones en `partitions.ts`.** Descubrimiento con caché por `partitionRefreshMs`, validación `^[0-9]{6}$` y cita del identificador; `chainReader.ts` solo lo consume.
5. **Legibilidad = error `42501`.** El acceso se otorga por partición; cualquier otro error es un fallo real y se propaga.
6. **Un equipo por llamada, un lector por proceso.** El orquestador los recorre en secuencia; así la carga sobre la BD es predecible.
7. **Alertas por callback** (`onAlert`), sin acoplar con el sistema de logs.
8. **Todo configurable por parámetros**, nunca por `process.env`: la lectura de entorno es de 006.

## Estructura
```
src/db/types.ts
src/detectors/
  types.ts
  micros.ts
  partitions.ts
  assignmentDetector.ts
  chainReader.ts
  index.ts
  __fixtures__/       filas de asignación y tramas reales (las siete de specs/003 sirven de contenido de bytea)
  detectors.test.ts
```

## Orden de trabajo
Mover `SqlClient` → asignaciones → `micros` → particiones → `initCursor` → `readNew` (deduplicación, ventana, límite) → cambio de partición y alertas → prueba de SQL (sin JOIN ni `SELECT *`).

## Riesgos
- Si la consulta devuelve `chainBatchLimit` filas, `hasMore` es verdadero. El cursor avanza si el lote contiene al menos una fila nueva; si todas son duplicadas, no avanza y se emite `CHAIN_WINDOW_SATURATED`.
- Cambio de partición en el borde de semana: se documenta la limitación de tramas tardías.

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
9. **Vigencia en una sola interfaz.** A1 usa el índice `empresa_por_estado4` con `int_estado IN (3, 4) AND bol_enuso`; `VIGENT_STATES` e `isActiveAssignment` se exportan por `index.ts` para que 002 aplique la misma regla a las filas de `getById`. Una prueba compara los literales SQL con la constante.
10. **Hora final informativa.** A1 y A2 conservan el SQL actual; el mapeo preserva `NULL` como `null` y tipa `horaFinal` como `Date | null`, porque se rellena al terminar la asignación.

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

Enmienda de estados: actualizar A1 → exportar constante y predicado → probar filtro SQL, coincidencia de estados y filas no vigentes.

Enmienda de hora final: ajustar tipo y mapeo → probar `null` y fecha sin cambiar A1/A2.

## Riesgos
- Si la consulta devuelve `chainBatchLimit` filas, `hasMore` es verdadero. El cursor avanza si el lote contiene al menos una fila nueva; si todas son duplicadas, no avanza y se emite `CHAIN_WINDOW_SATURATED`.
- Cambio de partición en el borde de semana: se documenta la limitación de tramas tardías.

# Spec 005 — Catálogo local (unidad, dispositivo y plan de ruta)

> La carpeta sigue llamándose `005-device-directory`; el código vive en `src/catalog/`.

## Objetivo
Resolver, sin JOINs, el equipo y el modelo de una unidad, y el plan de una ruta (tipo de ruta y
puntos en orden con coordenadas y radio). Los datos se guardan localmente y se revalidan por
`dt_modificacion` para no cargar a la BD.

## Fuera de alcance
- Consulta de asignaciones y tramas → `specs/001`.
- Persistencia en Redis → `specs/004` (aquí se usa `CatalogCacheStore`).
- Armado del comando → `specs/003`.
- Creación del pool de `pg` (máx. 3 conexiones, `statement_timeout` 5 s) → arranque del servicio (`specs/006`). Este módulo **recibe** un cliente.
- Qué se hace con una ruta de tipo 1 → `specs/002` (la omite con alerta) y futura `specs/009`.

## Interfaces
```typescript
interface SqlClient { query(text: string, values: unknown[]): Promise<{ rows: Record<string, unknown>[] }>; }

type ModelName = 'GV300W' | 'GV310LAU';          // el de specs/003
interface UnitDevice {
  unitId: number; companyId: number; deviceId: number;
  modelId: number; model: ModelName;
}
interface DeviceDirectory {
  // Se llama solo al iniciar una ruta; el resultado se guarda en el RouteState.
  resolveForRouteStart(unitId: number, expectedCompanyId: number): Promise<UnitDevice>;
}

interface RoutePlanPoint {
  pointId: number;          // tbl_punto_ruta.int_id
  order: number;            // int_orden
  siteId: number;           // int_idsitio
  latitude: number; longitude: number;
  radiusM: number;          // ya ajustado al mínimo de 50
  radiusAdjusted: boolean;
}
interface RoutePlan { routeType: 0 | 1; points: RoutePlanPoint[]; }   // routeType 1 => points vacío
interface RoutePlanRepository {
  getPlan(companyId: number, catalogRouteId: number, opts?: { forceFresh?: boolean }): Promise<RoutePlan>;
}

class UnknownModelError extends Error {}
class UnitValidationError extends Error {}
class InvalidPlanError extends Error {}
```
Todo se exporta desde `src/catalog/index.ts`; es lo único que otros módulos pueden importar.

## Consultas autorizadas (sin JOINs, por llave primaria o índice existente)
```sql
-- U1. Unidad (PK)
SELECT int_id, int_idempresa, int_iddispositivo, bol_enuso
FROM catalogos.tbl_unidad WHERE int_id = $1;

-- U2. Dispositivo (PK)
SELECT int_id, int_idmodelo_dispositivo, bol_enuso
FROM catalogos.tbl_dispositivo WHERE int_id = $1;

-- R1. Ruta: solo el tipo (PK)
SELECT int_id, int_idempresa, int_tipo, dt_modificacion
FROM catalogos.tbl_ruta WHERE int_id = $1;

-- P1. Puntos de la ruta (siempre tbl_punto_ruta; las versiones se ignoran)
SELECT int_id, int_idempresa, int_idruta, int_orden, bol_enuso, int_idsitio, dt_modificacion
FROM catalogos.tbl_punto_ruta WHERE int_idempresa = $1 AND int_idruta = $2;

-- S1. Sitio (PK, una consulta por sitio)
SELECT int_id, bol_enuso, int_radio, dt_modificacion,
       ST_Y(g_posicion::geometry) AS latitud, ST_X(g_posicion::geometry) AS longitud
FROM catalogos_gis.tbl_sitio WHERE int_id = $1;
```
Sin `ORDER BY` en SQL: el orden se aplica en código. Todas parametrizadas.

## Reglas
**Unidad, dispositivo y modelo**
- Se consultan **solo al iniciar la ruta** y no se releen durante ella. No se cachean en Redis.
- Mapa de modelos estático en código: `25` → `GV300W`, `100` → `GV310LAU`. Cualquier otro id lanza `UnknownModelError`; nunca hay valor por defecto.
- Unidad o dispositivo inexistentes, con `bol_enuso = false`, o con `int_idempresa` de la unidad distinto de `expectedCompanyId`, lanzan `UnitValidationError` (mensaje en español, con ids).

**Plan de ruta**
- Primero R1. Ruta inexistente, o con `int_idempresa` distinto de `companyId`, o con `int_tipo` distinto de 0 y 1 → `InvalidPlanError`.
- Si `int_tipo = 1`: se devuelve `{ routeType: 1, points: [] }` **sin consultar P1 ni S1**.
- Si `int_tipo = 0`: P1 y luego S1 por cada punto.
- Puntos: solo `bol_enuso`; orden por `int_orden` y desempate por `int_id`. Un plan sin puntos → `InvalidPlanError`.
- Sitio inexistente o con `bol_enuso = false` → `InvalidPlanError` con `pointId` y `siteId`.
- Radio: `int_radio` en metros. Nulo o no numérico → `InvalidPlanError`. Menor a 50 → se usa 50, `radiusAdjusted = true` y se registra un aviso. Mayor a 6 000 000 → `InvalidPlanError`.
- Latitud y longitud deben ser números finitos dentro de rango; si no, `InvalidPlanError`.
- Los valores numéricos que `pg` devuelva como texto se convierten con `Number()` y se validan.

**Caché (cache-aside)**
- Entidades en `CatalogCacheStore`: `route` (por `int_id`), `route-points` (por `int_idruta`) y `site` (por `int_id`).
- Un dato más joven que `CATALOG_REVALIDATE_MS` se usa sin consultar. Si es más viejo, se vuelve a leer y se compara con lo guardado: si el contenido (o `dt_modificacion`) cambió, se reemplaza y se registra “cambio detectado”; si no, solo se renueva `fetchedAt`.
- `forceFresh: true` ignora la caché en las tres entidades. El orquestador lo usa en cada cambio de paso.
- No se precargan catálogos al arrancar. Nunca se trae una tabla completa.
- Si Redis o la BD fallan, el error se propaga; nunca se responde con un dato inventado.

## Criterios de aceptación
- [ ] `resolveForRouteStart` devuelve unidad, dispositivo y modelo para los dos modelos del mapa (25 y 100).
- [ ] Modelo desconocido, unidad o dispositivo fuera de uso o inexistentes, y empresa distinta fallan con el error indicado.
- [ ] `getPlan` de una ruta tipo 0 devuelve los puntos en orden con latitud, longitud y radio.
- [ ] `getPlan` de una ruta tipo 1 devuelve `routeType: 1`, sin puntos, y no ejecuta P1 ni S1.
- [ ] Ruta inexistente, de otra empresa o con `int_tipo` inválido → `InvalidPlanError`.
- [ ] Radio 30 → 50 con `radiusAdjusted` y aviso; radio 7 000 000 → `InvalidPlanError`.
- [ ] Sitio faltante o en desuso → `InvalidPlanError` con ids. Plan sin puntos → `InvalidPlanError`.
- [ ] Un plan en caché joven no genera consultas; `forceFresh` sí.
- [ ] Una caché vieja con contenido distinto se reemplaza y registra el cambio.
- [ ] Ninguna consulta contiene `JOIN` ni `SELECT *` (prueba sobre las cadenas SQL).
- [ ] Pruebas con un `SqlClient` falso, fixtures con los ids reales de las consultas verificadas y Redis en memoria; no hay BD local.
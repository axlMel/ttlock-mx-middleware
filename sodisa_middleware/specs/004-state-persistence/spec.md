# Spec 004 — Persistencia de estado local (Redis)

## Objetivo
Persistir localmente el progreso de cada dispositivo a través de su ruta
(`RouteState`, usado por la FSM) y el cursor de lectura sobre el reporte de
cadenas (`PollingCursor`), de forma que ambos sobrevivan a un reinicio del
proceso o del contenedor, sin tocar jamás la base de datos externa de solo
lectura (principio V de la constitución).

## Alcance
- Almacenamiento y lectura de `RouteState` por dispositivo.
- Almacenamiento y lectura de `PollingCursor` por fuente de datos (hoy:
  `reporte_cadenas`; el diseño admite más fuentes sin cambios si en el
  futuro se agrega paginación a la tabla de rutas).

## Fuera de alcance
- Conexión a PostgreSQL → `specs/001-event-detectors` y `specs/005-device-directory`.
- Lógica de transición de estados de la FSM → `specs/002-queue-orchestrator`.
  Este módulo solo guarda y devuelve el estado; no decide cuándo cambia.

## Modelo de datos

```typescript
type FsmState =
  | 'PENDING' | 'CONFIGURING' | 'AWAITING_ACK'
  | 'IN_ZONE' | 'AWAITING_EXIT_ALERT' | 'COMPLETED' | 'FAILED';

interface RouteState {
  deviceId: string;      // IMEI
  routeId: string;
  currentSiteIndex: number;
  fsmState: FsmState;
  lastCommandSentAt: string; // ISO timestamp
  retryCount: number;
}
```

## Interfaces
```typescript
interface RouteStateStore {
  get(deviceId: string): Promise<RouteState | null>;
  set(deviceId: string, state: RouteState): Promise<void>;
  delete(deviceId: string): Promise<void>; // al completar o cancelar una ruta
}

interface PollingCursorStore {
  get(sourceName: string): Promise<string | null>;
  set(sourceName: string, cursorValue: string): Promise<void>;
}
```

## Convención de llaves en Redis
- `route:{deviceId}` → `RouteState` serializado en JSON.
- `cursor:{sourceName}` → valor plano del cursor (string), p. ej. `cursor:reporte_cadenas`.

## Reglas de negocio
- Si `route:{deviceId}` no existe, se interpreta como **"sin ruta activa"**
  — es un estado inicial válido, no un error.
- Si `cursor:{sourceName}` no existe, la siguiente consulta debe partir
  desde el principio (o desde el valor por defecto que defina esa fuente)
  — tampoco es un error.
- No se aplica TTL a `RouteState` en esta iteración: una ruta puede tardar
  en completarse y expirarla accidentalmente sería peor que no expirarla.
- Redis debe estar configurado con persistencia a disco (`appendonly yes`)
  para que el cursor y el estado sobrevivan a un reinicio — esto es un
  requisito de infraestructura, documentado en `docs/architecture.md`, no
  algo que el código pueda garantizar por sí mismo.

## Criterios de aceptación
- [ ] `RouteStateStore.get` devuelve `null` (no error) cuando no hay estado
      guardado para un `deviceId`.
- [ ] `RouteStateStore.set` seguido de `get` devuelve exactamente el mismo
      objeto guardado.
- [ ] `RouteStateStore.delete` elimina el estado; un `get` posterior vuelve
      a devolver `null`.
- [ ] `PollingCursorStore.get`/`set` tienen el mismo comportamiento de
      "no existe → null" para cursores.
- [ ] Ningún test de este módulo requiere una conexión a PostgreSQL.
- [ ] Los tests corren contra una implementación de Redis en memoria (no
      contra un Redis real) para no depender de infraestructura en CI.
# Spec 004 — Persistencia local (Redis)

## Objetivo
Guardar localmente, de forma que sobreviva a reinicios, el estado de cada ruta en
curso, el cursor de lectura de tramas por equipo y la caché de catálogo. Nunca se
escribe en la BD externa (principio V).

## Fuera de alcance
- Lógica de transiciones → `specs/002`.
- Consultas a la BD → `specs/001` y `specs/005`.
- Auditoría de comandos → `specs/007`.

## Modelo de datos
```typescript
type FsmState =
  | 'PENDING' | 'CONFIGURING' | 'AWAITING_ACK'
  | 'IN_ZONE' | 'AWAITING_EXIT_ALERT' | 'COMPLETED';

interface PendingRequest {
  idempotencyKey: string;
  body: { companyId: number; unitId: string; comando: string };
}

interface RouteState {
  assignmentId: number;          // es el routeId de logs y auditoría
  companyId: number;             // empresa de la plataforma
  apiCompanyId: number;          // companyId de la API de comandos
  unitId: number;
  deviceId: number;
  model: 'GV300W' | 'GV310LAU';
  catalogRouteId: number;        // int_idruta
  routeType: 0 | 1;              // int_tipo; en la v1 siempre 0 (las rutas tipo 1 no crean estado)
  fsmState: FsmState;
  currentPointId: number | null; // tbl_punto_ruta.int_id; null en el paso de reset
  completedPointIds: number[];
  stepSeq: number;               // contador de pasos; su hex de 4 dígitos es el serial
  transmissionSeq: number;       // transmisiones del paso actual (la primera es 1)
  retryCount: number;            // retransmisiones del paso (solo informativo)
  pendingRequest: PendingRequest | null; // guardada ANTES de llamar a la API
  lastAcceptedCommand: string | null; // comando del paso aceptado; ausente en estados antiguos equivale a null
  firstTransmissionAt: string | null; // ISO del primer intento del paso, guardado antes de invocar al gateway; ausente equivale a null
  ackDeadline: string | null;    // ISO: fin de la ventana de ACK de la última transmisión aceptada
  closing: null | { reason: 'ROUTE_DONE' | 'ASSIGNMENT_ENDED'; finalEstado: number | null };
  startedAt: string;
  updatedAt: string;
}

interface PartitionMark {
  partition: string;             // 'YYYYWW'
  dtTrama: string | null;        // texto con microsegundos como lo entrega la BD; null = inicio de la partición
  recentIds: number[];           // int_id ya procesados dentro de la ventana de solapamiento
}
interface ChainCursor extends PartitionMark {
  previous?: (PartitionMark & { hasMore: boolean }) | null; // solo nace al cruzar; hasMore permite terminar un drenaje tras los cinco minutos
}

interface CatalogEntry<T> { value: T; dtModificacion: string | null; fetchedAt: string }
```
`retryCount` es solo informativo: no decide ningún comportamiento (sin límites, sin fallo, sin pausa).

## Interfaces
```typescript
interface RouteStateStore {
  get(assignmentId: number): Promise<RouteState | null>;
  getByDevice(deviceId: number): Promise<RouteState | null>;
  set(state: RouteState): Promise<void>;
  delete(assignmentId: number): Promise<void>;
  list(): Promise<RouteState[]>;
}
interface ChainCursorStore {
  get(deviceId: number): Promise<ChainCursor | null>;
  set(deviceId: number, cursor: ChainCursor): Promise<void>;
  delete(deviceId: number): Promise<void>;
}
interface CatalogCacheStore {
  get<T>(entity: string, id: number): Promise<CatalogEntry<T> | null>;
  set<T>(entity: string, id: number, entry: CatalogEntry<T>): Promise<void>;
  delete(entity: string, id: number): Promise<void>;
}
```

## Llaves en Redis
- `route:{assignmentId}` → `RouteState` en JSON.
- `device-route:{deviceId}` → `assignmentId` (índice para despachar tramas).
- `chain-cursor:{deviceId}` → `ChainCursor` en JSON.
- `catalog:{entity}:{id}` → `CatalogEntry` en JSON.

## Reglas
- `set` de `RouteState` actualiza `route:` y `device-route:` en una sola transacción (`MULTI`); `delete` borra ambas llaves.
- `list()` recorre las llaves con `SCAN`, nunca con `KEYS`, y solo considera llaves `route:{número}`.
- Sin TTL en `RouteState`, cursores ni caché; la vigencia de la caché la decide la spec 005.
- Redis requiere `appendonly yes` y `maxmemory-policy noeviction` (requisito de despliegue; Ever).
- Leer algo inexistente devuelve `null`, no un error. `getByDevice` devuelve `null` si el índice apunta a una asignación que ya no existe.
- Al leer un `RouteState` anterior sin `lastAcceptedCommand`, se devuelve `lastAcceptedCommand: null`.
- Al leer un `RouteState` anterior sin `firstTransmissionAt`, se devuelve `firstTransmissionAt: null`. El campo se conserva en retransmisiones del mismo paso y se limpia al cambiar de paso.
- Un `ChainCursor` anterior sin `previous` es válido y se interpreta como `null`. El store guarda ambas marcas en la misma llave `chain-cursor:{deviceId}` para que sobrevivan juntas a un reinicio.
- **Valores corruptos** (JSON inválido en una llave): `get` y `getByDevice` lanzan `CorruptStateError` (mensaje en español con la llave). `list()` **omite** las llaves corruptas y avisa con un callback opcional `onCorrupt(key, error)`; nunca falla por una sola llave dañada (principio VII).

## Criterios de aceptación
- [ ] `RouteStateStore`: `get`, `set`, `delete` y `list` devuelven lo guardado; un inexistente devuelve `null`.
- [ ] `getByDevice` encuentra el estado por `deviceId`; tras `delete` devuelve `null`.
- [ ] `set` y `delete` mantienen consistentes `route:` y `device-route:`.
- [ ] `ChainCursorStore` y `CatalogCacheStore` guardan, leen y borran con el mismo comportamiento de "inexistente → `null`".
- [ ] `FsmState` no contiene `FAILED` ni `PAUSED`.
- [ ] `routeType` se guarda y se lee dentro del `RouteState`.
- [ ] `lastAcceptedCommand` se guarda y se lee; un estado antiguo sin el campo se lee con `null`.
- [ ] `firstTransmissionAt` y ambas marcas de `ChainCursor` hacen ida y vuelta en Redis; se leen estados antiguos sin esos campos.
- [ ] Un JSON corrupto hace que `get` lance `CorruptStateError`, y que `list()` omita esa llave, llame a `onCorrupt` y devuelva las demás.
- [ ] `list()` no incluye llaves `device-route:` ni otras ajenas a `route:{número}`.
- [ ] Ninguna prueba toca PostgreSQL ni requiere un Redis real.
- [ ] Las pruebas usan Redis en memoria (`ioredis-mock`).

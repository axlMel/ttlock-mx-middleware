# Spec 001 — Event Detectors

## Objetivo
Detectar, mediante polling administrado, (a) asignaciones de ruta vigentes
y (b) nuevos eventos en el reporte de cadenas (ACK y entradas/salidas de
zona), para alimentar al orquestador (`specs/002`).

## Fuera de alcance
- Decisión de qué hacer con cada evento (FSM) → `specs/002`.
- Parseo del contenido de la trama → `specs/003` (este módulo entrega las
  tramas crudas + metadatos, no las interpreta).
- Persistencia del cursor → `specs/004` (este módulo lo consume a través
  de la interfaz ya implementada, no lo reimplementa).

## Esquema de origen (ASUMIDO — pendiente de confirmación formal)
`asignaciones_rutas` (imei, latitud, longitud, radio, orden, estatus) y
`reporte_cadenas` (id_report, imei, trama, fecha). Ver `docs/architecture.md`.

## Interfaces
```typescript
interface RouteAssignment {
  imei: string;
  latitude: number;
  longitude: number;
  radius: number;
  order: number;
}

interface ChainReportRow {
  idReport: string;
  imei: string;
  raw: string;
}

interface RouteDetector {
  getActiveRoutes(): Promise<RouteAssignment[]>;
}

interface ChainReportDetector {
  getNewEvents(): Promise<ChainReportRow[]>;
}
```

## Reglas de negocio
- `getActiveRoutes` filtra por `estatus = 'vigente'` (nombre de columna
  asumido — confirmar con Paloma).
- `getNewEvents` usa `PollingCursorStore.get('reporte_cadenas')` (de
  `specs/004`) para saber desde dónde consultar, y `PollingCursorStore.set`
  para avanzarlo tras procesar el lote — nunca guarda el cursor en la BD
  externa (principio V).
- Este módulo expone funciones de **consulta puntual** (`getActiveRoutes`,
  `getNewEvents`) — no implementa el ciclo de polling en sí (intervalos,
  reintentos, logging ante fallo). Esa responsabilidad vive en
  `specs/002`, cuyo worker de BullMQ llama a estas funciones en cada tick
  de un job repetible — 001 no debe saber cuándo ni con qué frecuencia se
  le llama (misma separación aplicada en el resto del proyecto).

## Criterios de aceptación
- [ ] `getActiveRoutes` devuelve las rutas sembradas de prueba.
- [ ] `getNewEvents` devuelve solo las filas con `id_report` mayor al
      cursor guardado, y avanza el cursor correctamente tras procesarlas.
- [ ] Ambos detectores tienen tests de integración contra la BD local.
- [ ] Ningún detector realiza ninguna escritura sobre la BD externa.

## Fuera de alcance de esta iteración
- Notificación push / `LISTEN-NOTIFY` (fase 2, ya documentada en
  `docs/architecture.md` como pendiente futuro, no de esta iteración).
- Filtrado por empresa (campo mencionado como posible, no confirmado).
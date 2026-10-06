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
- Ambos detectores corren en intervalos configurables por entorno
  (`POLL_INTERVAL_MS_ROUTES`, `POLL_INTERVAL_MS_ACK`, ya en `AGENTS.md`).
- Si una consulta falla (conexión, timeout), se loggea y se reintenta en
  el siguiente ciclo — el proceso nunca se detiene por un fallo transitorio.

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
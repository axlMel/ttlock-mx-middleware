# Plan — 001-event-detectors

## Estructura de archivos
```
src/event-detectors/
  types.ts
  routeDetector.ts
  chainReportDetector.ts
  detectors.test.ts
```

## Decisiones técnicas
- **Cliente Postgres: `pg`**, mismo driver que 005 — y el mismo `Pool` de
  conexión compartido a nivel de aplicación (no uno distinto por módulo;
  un pool por módulo sería redundante, principio I).
- `chainReportDetector` recibe `PollingCursorStore` (de `specs/004`) como
  dependencia inyectada — se reutiliza tal cual, no se reimplementa.
- Consultas actuales (esquema local/asumido):
  ```sql
  -- routeDetector
  SELECT imei, latitud, longitud, radio, orden
  FROM asignaciones_rutas WHERE estatus = 'vigente';

  -- chainReportDetector
  SELECT id_report, imei, trama
  FROM reporte_cadenas WHERE id_report > $1
  ORDER BY id_report LIMIT 3000;
  ```
  Estas dos consultas son lo único que cambia cuando se confirme el
  esquema real — las interfaces (`RouteDetector`, `ChainReportDetector`)
  no cambian.

## Testing
- Igual que 005: contra la BD local real, no mocks — el objetivo es
  detectar pronto cualquier discrepancia de esquema, no ocultarla.
- Caso explícito para `chainReportDetector`: llamar dos veces seguidas y
  confirmar que la segunda llamada no repite filas ya devueltas.

## Alternativas descartadas
- **Un `Pool` de conexión por módulo:** descartado, redundante — un solo
  `Pool` compartido a nivel de aplicación (principio I).
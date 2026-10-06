# Plan — 005-device-directory

## Estructura de archivos
```
src/device-directory/
  types.ts
  deviceDirectory.ts       // implementación con pg
  deviceDirectory.test.ts
```

## Decisiones técnicas
- **Cliente Postgres: `pg`** y `@types/pg` como dependencia de desarrollo
  para el TypeScript estricto del proyecto. Una sola consulta
  simple no justifica un ORM — sería una dependencia extra sin necesidad
  real (principio I).
- Conexión vía `DATABASE_URL` (ya definida en `AGENTS.md`); en desarrollo
  apunta a la BD local de `docker-compose.yml`, publicada en el puerto 5433
  para no interferir con el PostgreSQL de Windows en 5432.
- El mapeo de `modelo` (string de BD) a perfil de `specs/003` vive **en
  este módulo** (una tabla de mapeo pequeña), no en 003 — 003 no debe saber
  de dónde viene el nombre del modelo (principio III).
- Consulta actual (sobre el esquema local/asumido):
  ```sql
  SELECT imei, modelo, ip, puerto FROM resumen_unidad WHERE imei = $1;
  ```
  Esta línea es la única que cambiará cuando se confirme el esquema real.

## Testing
- Tests de **integración contra la BD local real** (no mocks). El riesgo
  que este módulo debe atrapar es justamente el desface entre el esquema
  asumido y el real — un mock lo ocultaría en vez de exponerlo.
- El seed local incluye dos IMEIs reales y un IMEI ficticio con modelo
  desconocido para probar ambos errores mediante consultas de solo lectura.
- Requiere `docker compose up -d postgres` antes de correr; documentar en
  el `README`/`AGENTS.md` como prerequisito de este test suite.

## Alternativas descartadas
- **ORM (Prisma/TypeORM):** descartado, una sola consulta no lo justifica.
- **Mock de BD en vez de contenedor real:** descartado para este módulo —
  el objetivo es detectar discrepancias de esquema lo antes posible.

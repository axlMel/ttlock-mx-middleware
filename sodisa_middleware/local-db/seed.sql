-- ============================================================
-- ESQUEMA ASUMIDO 05/10/26 — pendiente de confirmación formal con
-- Gustavo (resumen_unidad, reporte_cadenas) y Paloma (rutas).
-- Diseñado a partir de lo que SÍ se necesita desde la lógica:
--   resumen_unidad: imei, modelo, ip, puerto
--   reporte_cadenas: id_report, imei, trama cruda, fecha
--   asignaciones de ruta: imei, latitud, longitud, radio, orden, estatus
-- Cuando se confirme el esquema real, solo cambiar la consulta SQL en
-- el plan.md del módulo correspondiente — la interfaz pública no cambia.
-- ============================================================

CREATE TABLE resumen_unidad (
  imei    VARCHAR(20) PRIMARY KEY,
  modelo  VARCHAR(20) NOT NULL,
  ip      VARCHAR(45) NOT NULL,
  puerto  INTEGER NOT NULL
);

CREATE TABLE reporte_cadenas (
  id_report  BIGSERIAL PRIMARY KEY,
  imei       VARCHAR(20) NOT NULL,
  trama      TEXT NOT NULL,
  fecha      TIMESTAMP NOT NULL DEFAULT now()
);

CREATE TABLE asignaciones_rutas (
  id        BIGSERIAL PRIMARY KEY,
  imei      VARCHAR(20) NOT NULL,
  latitud   NUMERIC(10,6) NOT NULL,
  longitud  NUMERIC(10,6) NOT NULL,
  radio     INTEGER NOT NULL,
  orden     INTEGER NOT NULL,
  estatus   VARCHAR(20) NOT NULL DEFAULT 'vigente' -- vigente | completada | cancelada
);

-- Dispositivos reales usados en las pruebas de campo
INSERT INTO resumen_unidad (imei, modelo, ip, puerto) VALUES
  ('863457050476769', 'GV300W',   '10.50.0.11', 55010),
  ('868589060960328', 'GV310LAU', '10.50.0.12', 55077);

-- Ruta de prueba de 2 sitios para el GV300W
INSERT INTO asignaciones_rutas (imei, latitud, longitud, radio, orden, estatus) VALUES
  ('863457050476769', 19.355383, -99.128206, 50, 1, 'vigente'),
  ('863457050476769', 19.360000, -99.130000, 60, 2, 'vigente');

-- Tramas reales capturadas en campo (reporte_cadenas)
INSERT INTO reporte_cadenas (imei, trama) VALUES
  ('863457050476769', '+ACK:GTGEO,270D04,863457050476769,,0,FFFF,20260921220939,03C8'),
  ('863457050476769', '+RESP:GTGEO,270D04,863457050476769,,,01,1,1,0.0,0,2257.0,-99.127905,19.355447,20260921220959,0334,0020,0336,8F3D,00,0.2,20260921220959,03C9'),
  ('863457050476769', '+RESP:GTGEO,270D04,863457050476769,,,00,1,1,3.3,79,2258.0,-99.127571,19.355516,20260921221159,0334,0020,2C1A,90489A1,00,0.2,20260921221159,03CD'),
  ('868589060960328', '+ACK:GTGEO,6E0A03,868589060960328,,0,FFFF,20260925001304,01CA'),
  ('868589060960328', '+RESP:GTGIN,6E0A03,868589060960328,,,0,1,00000001,,,,,1,1,0.0,0,2248.0,-99.128239,19.355355,20260925002252,0334,0020,024A,015FAD2B,00,0.0,20260925002253,01F9'),
  ('868589060960328', '+RESP:GTGOT,6E0A03,868589060960328,,,0,1,00000001,,,,,1,1,0.0,0,2249.8,-99.128245,19.355360,20260925002356,0334,0020,024A,015FAD2B,00,0.0,20260925002357,0206');

-- IMEI ficticio, solo para probar el manejo de modelo no reconocido —
-- no corresponde a un dispositivo real.
INSERT INTO resumen_unidad (imei, modelo, ip, puerto) VALUES
  ('000000000000000', 'MODELO_INVALIDO', '0.0.0.0', 0);
# docs/architecture.md — gtlock-middleware
 
> Documento vivo de contexto operativo y hallazgos de campo. Se actualiza
> conforme se confirman datos con Ever (servidor/red) y Gustavo/Paloma (BD).
> No contiene principios (eso vive en `constitution.md`) ni guía operativa
> estable (eso vive en `AGENTS.md`) — aquí van los hechos concretos del
> entorno real, que cambian conforme se investiga.
 
## Red y conectividad
- El middleware se aloja en el servidor `34.59.160.16`, que tiene ruta de
  red hacia la APN privada de Telcel (**APN2**) donde viven los equipos GPS.
- Cada dispositivo recibe una IP distinta dentro de esa APN, asignada por
  Telcel. No hay una IP de destino fija compartida.
- El envío es UDP puro (no WebSocket, no TCP): sin conexión, sin handshake,
  sin confirmación de entrega en el mismo socket. Confirmado por prueba de
  campo en ambos modelos.
- Puertos de escucha observados: `55010` (GV300W), `55077` (GV310LAU) — el
  código **no** los codifica como constante fija por modelo; siempre se
  toman del valor devuelto por `resumen_unidad` para ese IMEI (ver AGENTS.md).
## Flujo de datos confirmado (3 tablas)
1. **Tabla de asignaciones activas de rutas** (nombre exacto pendiente de
   confirmar con Paloma — no es el catálogo de rutas existente). Debe traer
   `imei, latitud, longitud, radio` por sitio.
2. **`resumen_unidad`**: dado un IMEI, devuelve `modelo, ip, puerto`. Ya
   confirmado con Gustavo que incluye el modelo — no se necesita heurística
   por TAC del IMEI.
3. **`reporte_cadenas`**: contiene, como trama cruda, tanto el ACK de
   configuración como los eventos de entrada/salida de zona. Se pagina por
   `id_report` con un cursor guardado en Redis (nunca en la BD externa).
## Acceso a base de datos
- **Confirmado:** acceso directo de solo lectura a PostgreSQL (usuario y
  contraseña), sin capa de API/microservicio intermedia.
- **Pendiente de Gustavo:** credenciales concretas y nombres exactos de
  columnas de `reporte_cadenas` y `resumen_unidad`.
- **Pendiente de Paloma:** nombre de la tabla/vista de asignaciones activas
  de rutas.
## Redis — requisito de infraestructura
- Redis se usa tanto para BullMQ (colas) como para `RouteState` y
  `PollingCursor` (ver `specs/004-state-persistence`).
- **Debe configurarse con persistencia a disco (`appendonly yes`)** para
  que el estado de ruta y el cursor de polling sobrevivan a un reinicio del
  proceso o del contenedor. Esto es responsabilidad de despliegue (Ever),
  no algo que el código de la aplicación pueda garantizar por sí mismo.
## Estado del protocolo por modelo
- **GV300W:** implementado y probado en campo. Comando, ACK y eventos de
  zona (`+RESP:GTGEO`) confirmados. Ver `specs/003-queclink-protocol/spec.md`.
- **GV310LAU:** implementado y probado en campo. Usa reporte estándar por
  `Mode` (no parking fence): entrada = `+RESP:GTGIN`, salida = `+RESP:GTGOT`.
  Ambigüedad inicial (una muestra previa mostraba `+RESP:GTGES`) quedó
  descartada — esa muestra correspondía a otro mecanismo, no al que usa
  este proyecto.
## Pendientes activos
| Pendiente | Responsable | Bloquea |
|---|---|---|
| Credenciales de solo lectura a Postgres | Gustavo | `specs/001`, `specs/005` |
| Nombres exactos de columnas de `reporte_cadenas`/`resumen_unidad` | Gustavo | `specs/001`, `specs/005` |
| Tabla de asignaciones activas de rutas | Paloma | `specs/001` |
| Configurar `appendonly yes` en Redis de despliegue | Ever | Producción de `specs/004` |
 
## Historial de correcciones de entendimiento
- Se descartó la hipótesis de que `10.18.xxx.204:55077`/similar fuera un
  WebSocket — es UDP puro, confirmado por Ever.
- Se descartó la hipótesis de una IP de destino única para todos los
  dispositivos — cada uno tiene la suya, resuelta vía BD.
- Se descartó guardar el cursor de polling en una tabla nueva de la BD
  externa (sugerencia original de Gustavo) — viola el principio V de la
  constitución; se usa Redis en su lugar.
- Se descartó el mecanismo de parking fence (`GTGES`) para GV310LAU — el
  proyecto usa el geofence estándar (`GTGIN`/`GTGOT`), confirmado por
  prueba real.
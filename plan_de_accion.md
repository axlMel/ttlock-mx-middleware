# Plan de acción — Comunicación UDP (gtlock-middleware ↔ GlobalTrack)

> Basado en la prueba de funcionalidad `Pruebas GV300W - (Búsqueda de eventos)`
> (IMEI 863457050476769, servidor `10.18.xxx.204:55077`, respuesta observada
> en `201.xxx.125.245`). Este documento divide responsabilidades entre la
> administración del servidor GlobalTrack (Ever y Gustavo) y el desarrollo del
> middleware (Axel).

## Lo que la prueba ya demostró (no requiere más validación de Ever)
- El canal UDP hacia `10.18.xxx.204:55077` acepta y reenvía comandos `AT+GTGEO` al GV300W correctamente.
- El GV300W ejecuta la regla de geocerca (apertura/revocación) al recibir el comando.
- El emisor del comando **no** recibe respuesta en el mismo socket UDP — es un envío *fire-and-forget* por diseño de este canal.
- Tanto el ACK de configuración como los eventos de entrada/salida de geocerca quedan registrados en el **reporte de cadenas** de la plataforma Sphere, como cadenas `+ACK:GTGEO` y `+RESP:GTGEO` respectivamente.

Esto significa que el trabajo de Globaltrack **no es "hacer que funcione el envío"** eso ya funciona. Su trabajo es **formalizar y garantizar el acceso confiable** a las dos puntas que el middleware necesita consumir en producción.

---

## Parte 1 — Responsabilidad de administración del servidor GlobalTrack

### 1.1 Confirmar y documentar el canal de envío en firme (Ever)
- [ ] Confirmar que `10.18.xxx.204:55077` es el endpoint definitivo (o indicar cuál es el de producción, si este es solo de prueba).
- [ ] Confirmar si el servidor GlobalTrack requiere que la IP del middleware esté en whitelist/firewall para poder enviar. Si es así, proporcionar el procedimiento de alta.
- [ ] Documentar si existe algún límite de tasa (rate limit) de comandos por segundo/minuto hacia este servidor.
- [ ] Confirmar si el servidor persiste/loguea algo del lado de GlobalTrack cuando un comando llega mal formado o a un IMEI inexistente (para que el middleware sepa si un fallo silencioso es network o lógico).

### 1.2 Acceso al reporte de cadenas, la pieza crítica (Gustavo)
- [ ] Proveer el **método de acceso de lectura** al reporte de cadenas que el middleware pueda consumir de forma automatizada — no manual vía la interfaz web de Sphere. Esto puede ser:
  - Acceso de solo lectura a la base de datos/vista donde se almacena ese reporte, **o**
  - Un endpoint de API de Sphere que lo exponga.
- [ ] Documentar el **esquema exacto** de ese reporte: nombre de tabla/vista, columnas, tipos de dato, y cómo se distingue `+ACK:GTGEO` de `+RESP:GTGEO` de cualquier otra cadena que llegue del mismo dispositivo.
- [ ] Confirmar **cómo correlacionar** una cadena de respuesta con el comando específico que la originó. En la prueba, el campo `270D04` aparece tanto en el `ACK` como en el `RESP` — confirmar si ese campo (o algún otro) es un identificador de sesión/secuencia útil para correlación, o si la correlación debe hacerse solo por ventana de tiempo + IMEI.
- [ ] Confirmar la latencia esperada entre el envío del comando y la aparición del registro en el reporte de cadenas (en la prueba fue ~30–40 segundos; confirmar si esto es representativo o varía).
- [ ] Confirmar si el reporte de cadenas es una tabla en vivo (consultable por polling) o requiere generación de reporte bajo demanda.

### 1.3 Alcance de su labor
El trabajo de GT **no termina** solo con el servidor UDP operativo. Se considera completo cuando:
- El middleware tiene credenciales/acceso de solo lectura funcionando contra el reporte de cadenas (no solo la descarga manual vía Sphere).
- El esquema de ese reporte está documentado por escrito (aunque sea de forma breve).
- Queda claro el mecanismo de correlación comando→respuesta.

---

## Parte 2 — Responsabilidad del desarrollador de middleware (Axel)

### 2.1 Módulo de protocolo UDP (`specs/003-queclink-protocol`)
- [ ] Implementar el armado del comando `AT+GTGEO` sustituyendo latitud, longitud y radio según el sitio actual de la ruta.
- [ ] Implementar el envío por socket UDP (`dgram`, fire-and-forget, sin esperar respuesta en el mismo socket) hacia el host/puerto que confirme Ever.
- [ ] Definir el parseo de `+ACK:GTGEO` y `+RESP:GTGEO` (incluyendo el decoding del campo geocerca+estado) como funciones puras, testeables sin red ni BD (principio III de la constitución).

### 2.2 Poller del reporte de cadenas (`specs/001-event-detectors`)
- [ ] Una vez Ever entregue el método de acceso (2.2 de su parte), implementar el poller que consulte ese origen y clasifique cada registro nuevo como ACK o evento de geocerca.
- [ ] Implementar la lógica de correlación comando→respuesta según lo que Ever confirme (por campo de sesión o por ventana de tiempo + IMEI).

### 2.3 Orquestador (`specs/002-queue-orchestrator`)
- [ ] Consumir los eventos clasificados del poller para avanzar la FSM (`AWAITING_ACK → IN_ZONE → AWAITING_EXIT_ALERT → siguiente sitio`), como ya se diseñó.
- [ ] Implementar el reintento de envío UDP cuando no aparece ACK dentro del timeout configurado (`ACK_MAX_RETRIES`, `ACK_RETRY_BACKOFF_MS`).

### 2.4 Pendiente fuera de este plan
- La consulta exacta de rutas (lat/lon/radio) — área de oportunidad #1 de la prueba — **no es responsabilidad de Ever ni depende del canal UDP**; es un pendiente separado con el equipo de base de datos de rutas.

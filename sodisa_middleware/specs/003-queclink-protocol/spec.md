
Specs 003 queclink protocol spec · MD
# Spec 003 — Protocolo Queclink (envío de comandos y parseo de respuestas)
 
## Objetivo
Enviar comandos de configuración de geocerca a dispositivos Queclink por UDP
y parsear las respuestas (ACK de configuración y eventos de entrada/salida
de zona) provenientes del reporte de cadenas, de forma independiente al
modelo específico de dispositivo.
 
## Fuera de alcance de esta spec
- Resolución de IP/puerto/modelo por IMEI → `specs/005-device-directory`.
- Consulta y paginación sobre el reporte de cadenas → `specs/001-event-detectors`.
- Persistencia del cursor de polling → `specs/004-state-persistence`.
Esta spec solo define: cómo se arma un comando, y cómo se interpreta una
cadena de respuesta ya obtenida. No sabe de dónde vienen ni a dónde van los
datos.
## Alcance de esta iteración
- **Implementado y probado en campo, ambos modelos:** GV300W y GV310LAU.
  Todos los ejemplos de este documento provienen de pruebas reales, no de
  ejemplos del manual.
## Concepto: perfil de dispositivo
Cada modelo se representa como un perfil de configuración, no como código
distinto. La lógica de armado y parseo es genérica y opera sobre el perfil
recibido (principio III de la constitución: separación entre lógica de
dominio e interfaz técnica).
 
```typescript
interface DeviceProfile {
  commandDeviceName: 'gv300w' | 'gv310lau';
  zoneReportNames: { enter: string; exit: string }; // ver tabla abajo
}
```
El armado del comando **no** es un método del perfil — es la función libre
`buildGeoCommand(profile: DeviceProfile, params: GeoParams): string`,
definida en `command.ts` (ver `plan.md`). El perfil es solo datos; la
lógica de armado es genérica y opera sobre cualquier perfil que reciba.
 
## Comando de configuración
 
### GV300W
```
AT+GTGEO={commandDeviceName},0,{mode},{lon},{lat},{radio},30,0,0,0,0,0,0,,,0,FFFF$
```
Ejemplo real (Mode=3, reporta entrada y salida):
```
AT+GTGEO=gv300w,0,3,-99.128206,19.355383,50,30,0,0,0,0,0,0,,,0,FFFF$
```
 
### GV310LAU
```
AT+GTGEO={commandDeviceName},0,{mode},{lon},{lat},{radio},30,0,0,0,0,0,0,0000,0000,0,FFFF$
```
Ejemplo real (Mode=3):
```
AT+GTGEO=gv310lau,0,3,-99.128206,19.355383,50,30,0,,0,0,0,0,0000,0000,0,FFFF$
```
Nota: el campo "Output Status" (posición 8) se observó vacío en la prueba
real y el equipo lo aceptó; el manual documenta `0` como default. Se usará
`0` como valor generado por el middleware (más explícito y dentro de lo
documentado), sin que esto se considere un caso de error si en campo se
observa vacío.
 
### Comando de reset (fin de ruta) — ambos modelos
Usar `Mode=0` (desactiva la función de geocerca según el manual oficial),
**no** coordenadas/radio en cero — el radio documentado tiene rango mínimo
de 50m y un valor de 0 está fuera de rango:
```
AT+GTGEO={commandDeviceName},0,0,0.000000,0.000000,50,30,0,0,0,0,0,0,,,0,FFFF$   (GV300W)
AT+GTGEO={commandDeviceName},0,0,0.000000,0.000000,50,30,0,0,0,0,0,0,0000,0000,0,FFFF$  (GV310LAU)
```
 
## Respuestas — ejemplos reales de referencia
| Modelo | Tipo | Cadena |
|---|---|---|
| GV300W | ACK | `+ACK:GTGEO,270D04,863457050476769,,0,FFFF,20260921220939,03C8` |
| GV300W | Entrada | `+RESP:GTGEO,270D04,863457050476769,,,01,1,1,0.0,0,2257.0,-99.127905,19.355447,20260921220959,0334,0020,0336,8F3D,00,0.2,20260921220959,03C9` |
| GV300W | Salida | `+RESP:GTGEO,270D04,863457050476769,,,00,1,1,3.3,79,2258.0,-99.127571,19.355516,20260921221159,0334,0020,2C1A,90489A1,00,0.2,20260921221159,03CD` |
| GV310LAU | ACK | `+ACK:GTGEO,6E0A03,868589060960328,,0,FFFF,20260925001304,01CA` |
| GV310LAU | Entrada | `+RESP:GTGIN,6E0A03,868589060960328,,,0,1,00000001,,,,,1,1,0.0,0,2248.0,-99.128239,19.355355,20260925002252,0334,0020,024A,015FAD2B,00,0.0,20260925002253,01F9` |
| GV310LAU | Salida | `+RESP:GTGOT,6E0A03,868589060960328,,,0,1,00000001,,,,,1,1,0.0,0,2249.8,-99.128245,19.355360,20260925002356,0334,0020,024A,015FAD2B,00,0.0,20260925002357,0206` |
 
## Invariantes de parseo confirmados
 
1. **IMEI**: siempre el 2° campo (índice 1) tras el encabezado, en todos los
   tipos de reporte y ambos modelos. Este es el único campo que puede
   leerse igual sin conocer el perfil del dispositivo.
2. **Familia GTGEO** (GV300W, ambas direcciones comparten el mismo nombre
   de reporte): el 5° campo (índice 4) combina en dos caracteres hex
   [ID de geocerca][estado], donde estado = `1` entrada, `0` salida.
3. **Familia GTGIN/GTGOT** (GV310LAU): la dirección la determina el
   **nombre del reporte**, no un campo combinado — `GTGIN`=entrada,
   `GTGOT`=salida. El campo de ID de geocerca (índice 4) va solo, sin
   estado embebido.
**Consecuencia de diseño:** no existe un único parser universal — hay un
parser por familia de reporte, seleccionado por el perfil del dispositivo.
Esto no es complejidad de más: es la forma real del protocolo, y cada
parser individual es más simple que intentar forzar un formato común.
 
## Salida esperada del parser (normalizada, independiente del modelo)
```typescript
type ParsedMessage =
  | { kind: 'ack'; imei: string; raw: string }
  | { kind: 'zoneEvent'; imei: string; geofenceId: string; event: 'enter' | 'exit'; raw: string }
  | { kind: 'unknown'; raw: string };
```
El orquestador solo consume `imei`, `geofenceId`, `event` y `kind` — el
resto de los campos de telemetría (velocidad, celda, HDOP, etc.) se
consideran presentes pero **fuera de alcance de parseo** en esta iteración.
 
## Reglas de negocio
- El envío del comando es *fire-and-forget* por UDP: no se espera respuesta
  en el mismo socket (confirmado en ambos modelos por prueba de campo).
- Los parsers de ACK y de eventos de zona son funciones puras: reciben una
  cadena de texto y el perfil del dispositivo, devuelven `ParsedMessage`,
  sin dependencia de red, BD ni cola.
- Al completar el último sitio de una ruta, se envía el comando de reset
  (`Mode=0`) antes de marcar la ruta como finalizada.
## Criterios de aceptación
- [ ] `buildGeoCommand(profile, { lat, lon, radius, mode })` produce
      exactamente las cadenas probadas en campo para ambos modelos,
      incluyendo el comando de reset (`mode=0`).
- [ ] `parseMessage(profile, raw)` clasifica correctamente los seis
      ejemplos reales de este documento (ack + entrada + salida, por
      modelo) como `ParsedMessage`.
- [ ] Ambas funciones tienen cobertura de test con las cadenas reales de
      este documento como fixtures — sin mocks de red ni BD.
- [ ] El selector de parser por familia de reporte (GTGEO vs GTGIN/GTGOT)
      se resuelve a partir del perfil del dispositivo, nunca adivinando
      por el contenido de la cadena.
## Fuera de alcance de esta iteración
- Parseo de campos de telemetría no usados por la FSM (velocidad, celda,
  HDOP, altitud, etc.) — se preservan en `raw` pero no se exponen tipados.
- Soporte a un tercer modelo no mencionado en esta spec.
 
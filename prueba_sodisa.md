# Pruebas GV300W - (Busqueda de eventos)
Este a rchivo funciona como guía histórica de las pruebas realizadas con un dispositivo  **Queclink - GV300W**.
El archivo de configuración utilizado para este ejercicio se encuentra adjunto en (`config/GTUDF_&_GTCMD_GTLOCK.gv300w`) el material de video se encuentra en la ruta (`media/`). 
**Por favor descargar el reporte de cadenas de [Sphere](https://admin.spheregt.com/index.php) con la siguiente información:**
```
Dispositivo: 863457050476769
Fecha inicio: 21/09/2026 04:00 PM
Fecha Fin: 21/09/2026 11:30 PM
Empresa/Cuenta: GLOBALTRACK MEXICO
/"Reporte de Cadenas.xlsx"
```
## I. Comienzo de prueba 04:08 PM
Recibimos la ruta por medio de consulta directa a la base de datos **metodología polling** (`por definir consulta exacta`). 
A las 04:09 P.M simulamos el envío del primer punto de interés por medio del middleware. El comando exacto es: 
```
AT+GTGEO=gv300w,0,3,-99.128206,19.355383,50,30,0,0,0,0,0,0,,,0,FFFF$
```
La respuesta que buscamos en cadena llegó inmediatamente a las 04:09:40 PM pero como bien sabemos:
**El ACK llega al servidor primario, no al emisor del comando**
```
+ACK:GTGEO,270D04,863457050476769,,0,FFFF,20260921220939,03C8
```
**Registro de video en:** (`media/01-Configuración.mp4`).
> **1.- Definir [Consulta de rutas]() se necesita (latitud, longitud y radio).**

> **2.-Necesitamos conocer la [respuesta ACK]() y rastrear a que BD se puede consultar.**
## II. Entrada a zona configurada
Una vez el GV300W calcula su posición dentro de la zona configurada se dispara la regla para **autorizar la apertura** de bóveda (`el ejercicio se inició dentro de la zona autorizada 1`). 
A las 04:09 P.M inmediatamente después de recibir la configuración ejecutó la regla y habilitó el pulso de autorización.
 ```
//Esta cadena no es necesaria forzosamente para la entrada.
+RESP:GTGEO,270D04,863457050476769,,,01,1,1,0.0,0,2257.0,-99.127905,19.355447,20260921220959,0334,0020,0336,8F3D,00,0.2,20260921220959,03C9
```
Si analizamos la cadena el tercer parámetro después del IMEI "01" podemos obtener datos de id de geocerca + entrada o salida en estado booleano.
siendo el primer caractér el ID de geocerca en hexadecimal seguido del estado, siendo 1=Entrada a zona 0=Salida de zona.
Por lo que "01" se puede interpretar como:

**ID de Geocerca: 0**

**Estado: 1(Entrada a zona)**

## III. Salida de zona configurada
Si bien la entrada a zona puede ser redundante la salida no, ya que **es el trigger que da como finalizada la visita** (`necesitamos si o si establecer un método que permita leer la salida de geocerca`). 

A las 04:11 P.M salimos de la zona del primer punto de interés, al mismo tiempo se ejecuta la regla para revocar la autorización de apertura a la bóveda..
 ```
+RESP:GTGEO,270D04,863457050476769,,,00,1,1,3.3,79,2258.0,-99.127571,19.355516,20260921221159,0334,0020,2C1A,90489A1,00,0.2,20260921221159,03CD
```
Como bien comentamos anteriormente **"00"** hace referencia al ID de geocerca = 0, en un evento de Salida de zona = 0.
**Registro de video en:** (`media/02-Entrada y Salida.mp4`).
> **3.- Necesitamos saber si esta integrada la [respuesta RESP:GTGEO]() en algún evento de plataforma o se puede leer de alguna forma "en bruto". Conocer la salida de geocerca**

## IV. Finalización de sitio/ruta
Ya que se ha finalizado el punto 3 podemos dar por terminada la visita al sitio perteneciente a la ruta y el Middleware a través de un sistema de colas debe proceder a recorrer del punto 1 al 3 con el siguiente punto de la ruta.  

Una vez finalizado el último sitio se debe proceder a limpiar las coordenadas de la configuración del GV300W y emitir notificación al administrador.

**Registro de video en:** (`media/03-Siguiente punto.mp4`). 
****
### Áreas de oportunidad
> **1.- Definir [Consulta de rutas]() se necesita (latitud, longitud y radio).**

> **2.-Necesitamos conocer la [respuesta ACK]() y rastrear a que BD se puede consultar.**

> **3.- Necesitamos saber si esta integrada la [respuesta RESP:GTGEO]() en algún evento de plataforma o se puede leer de alguna forma "en bruto". Conocer la salida de geocerca**
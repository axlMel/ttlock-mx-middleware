# Despliegue de GTLock en CentOS Stream 10

Esta guía usa `sudo` desde la cuenta administradora del servidor. Los bloques de
servidor se ejecutan allí; los de desarrollo, en una máquina con internet. Sustituya
`<servidor>`, `<version>` y `<archivo>` por los datos de su instalación. Nunca escriba
un secreto en la línea de comandos ni en un archivo del repositorio. Infraestructura
debe permitir únicamente salidas a PostgreSQL `192.168.20.20:5500`, la API
`metrics.globaltrack.com.mx:443` y Valkey local `127.0.0.1:6379`; también define
las actualizaciones del sistema operativo.

## 0. Verificar el servidor

```bash
uname -m
timedatectl
getenforce
df -h /opt /var
```

Compruebe `x86_64`, reloj sincronizado, SELinux `Enforcing` y espacio para paquetes,
dos versiones y la auditoría. Un reloj incorrecto altera las ventanas de asignación;
la arquitectura y los RPM del paso siguiente deben coincidir.

## 1. Instalar Node.js y Valkey sin internet en el servidor

En una máquina con internet y Docker, descargue el cierre completo de RPM de CentOS
Stream 10. `--alldeps` incluye dependencias aunque el contenedor ya las tenga.

```bash
mkdir -p rpms
docker run --rm --platform linux/amd64 -v "$PWD/rpms:/rpms:Z" quay.io/centos/centos:stream10 bash -lc 'dnf install -y dnf5-plugins && dnf download --resolve --alldeps --destdir /rpms nodejs valkey'
scp rpms/*.rpm <servidor>:/tmp/
```

Si Docker no está disponible, ejecute `sudo dnf install -y dnf5-plugins` y
`dnf download --resolve --alldeps --destdir ./rpms nodejs valkey` en otra máquina
CentOS Stream 10 **x86_64** con internet y copie los RPM de la misma manera.
En el servidor, valide la firma antes de instalar; `--disablerepo='*'` impide que
intente acudir a repositorios inaccesibles.

```bash
cd /tmp
rpm -K ./*.rpm
sudo dnf install --disablerepo='*' ./*.rpm
node --version
rpm -q valkey
```

Si falta una dependencia, inspeccione el RPM señalado con `rpm -qpR <archivo>.rpm`,
descárguela en la máquina conectada y repita la copia, la firma y la instalación.

## 2. Crear usuario y directorios

El servicio corre como `gtlock`, sin acceso interactivo ni grupos administrativos.
Las versiones y la configuración pertenecen a root; solo el estado y la auditoría
pertenecen al servicio.

```bash
sudo useradd --system --user-group --no-create-home --home-dir /var/lib/gtlock-middleware --shell /usr/sbin/nologin gtlock
sudo install -d -o root -g root -m 0755 /opt/gtlock-middleware /opt/gtlock-middleware/releases
sudo install -d -o root -g root -m 0755 /etc/gtlock-middleware
sudo install -d -o root -g root -m 0700 /etc/gtlock-middleware/credentials
sudo install -d -o gtlock -g gtlock -m 0750 /var/lib/gtlock-middleware /var/lib/gtlock-middleware/audit
sudo restorecon -Rv /opt/gtlock-middleware /etc/gtlock-middleware /var/lib/gtlock-middleware
id gtlock
```

## 3. Configurar Valkey local con contraseña

Confirme que el paquete instaló los nombres esperados antes de continuar:

```bash
rpm -ql valkey | grep -E '/(valkey\.conf|valkey\.service|valkey-cli)$'
```

Tras subir el artefacto en el paso 4, copie su fragmento. Si aún no dispone de él,
suba `deploy/valkey-gtlock.conf` desde desarrollo con
`scp deploy/valkey-gtlock.conf <servidor>:/tmp/`. En el servidor:

```bash
sudo install -o root -g root -m 0644 /tmp/valkey-gtlock.conf /etc/valkey/gtlock-middleware.conf
sudo grep -qxF 'include /etc/valkey/gtlock-middleware.conf' /etc/valkey/valkey.conf || printf '%s\n' 'include /etc/valkey/gtlock-middleware.conf' | sudo tee -a /etc/valkey/valkey.conf >/dev/null
sudo bash
umask 077
valkey_password="$(openssl rand -hex 32)"
printf 'requirepass %s\n' "$valkey_password" > /etc/valkey/gtlock-auth.conf
chown root:valkey /etc/valkey/gtlock-auth.conf
chmod 0640 /etc/valkey/gtlock-auth.conf
printf 'redis://:%s@127.0.0.1:6379\n' "$valkey_password" > /etc/gtlock-middleware/credentials/redis-url
chown root:root /etc/gtlock-middleware/credentials/redis-url
chmod 0600 /etc/gtlock-middleware/credentials/redis-url
unset valkey_password
exit
sudo restorecon -Rv /etc/valkey /etc/gtlock-middleware/credentials
sudo systemctl enable --now valkey.service
valkey-cli --askpass ping
valkey-cli --askpass CONFIG GET appendonly
valkey-cli --askpass CONFIG GET maxmemory-policy
```

Antes de `unset`, guarde la contraseña generada en el gestor de secretos de
infraestructura con su procedimiento aprobado. Introdúzcala cuando `--askpass` la
solicite; no la pegue en un comando o en el historial. Espere `PONG`,
`appendonly yes` y `maxmemory-policy noeviction`.
La contraseña se usa en ambos archivos; el valor hexadecimal evita codificación
especial en la URL. El fragmento fija el puerto en loopback y AOF conserva el estado.

## 4. Construir y copiar el artefacto

En desarrollo, con dependencias instaladas y acceso a npm:

```bash
npm run package
ls release/*.tar.gz release/*.sha256
scp release/*.tar.gz release/*.sha256 <servidor>:/tmp/
```

El script compila, instala solo dependencias de producción en un directorio temporal
y rechaza módulos nativos; el servidor no necesita npm ni acceso al registro. En el
servidor, sustituya `<archivo>` por el nombre completo del `.tar.gz` copiado:

```bash
cd /tmp
sha256sum -c <archivo>.sha256
sudo install -d -o root -g root -m 0755 /opt/gtlock-middleware/releases/<version>
sudo tar -xzf <archivo> -C /opt/gtlock-middleware/releases/<version>
sudo chown -R root:root /opt/gtlock-middleware/releases/<version>
sudo ln -s /opt/gtlock-middleware/releases/<version> /opt/gtlock-middleware/current.new
sudo mv -Tf /opt/gtlock-middleware/current.new /opt/gtlock-middleware/current
sudo restorecon -Rv /opt/gtlock-middleware
```

Guarde la versión anterior: cambiar `current` permite revertir sin reconstruir.

## 5. Crear las tres credenciales

`redis-url` se creó en el paso 3. Cree las otras dos como root, sin eco ni historial.
La URL de BD la entrega ElevenMinds y la clave de API su responsable. El bloque
usa variables de Bash y `printf` incorporado: ningún valor aparece como argumento
de otro proceso. No cambie el nombre de los archivos; systemd los busca así.

```bash
sudo bash
umask 077
read -rs -p 'COMMAND_API_KEY: ' api_value; printf '\n'
printf '%s\n' "$api_value" > /etc/gtlock-middleware/credentials/command-api-key
unset api_value
read -rs -p 'DATABASE_URL: ' db_value; printf '\n'
printf '%s\n' "$db_value" > /etc/gtlock-middleware/credentials/database-url
unset db_value
chmod 0600 /etc/gtlock-middleware/credentials/command-api-key /etc/gtlock-middleware/credentials/database-url /etc/gtlock-middleware/credentials/redis-url
chown root:root /etc/gtlock-middleware/credentials/command-api-key /etc/gtlock-middleware/credentials/database-url /etc/gtlock-middleware/credentials/redis-url
exit
sudo ls -l /etc/gtlock-middleware/credentials
```

Para rotar API o BD, reemplace solo el archivo correspondiente con el mismo método
y reinicie `gtlock-middleware`. Para Valkey, detenga el middleware, genere una nueva
contraseña y reescriba **ambos** archivos del paso 3; reinicie Valkey y luego el
middleware. La clave de API y la contraseña de BD las emiten sus responsables.

## 6. Instalar unidad, entorno y retención

Use los archivos de la versión instalada. El entorno contiene solo valores no
secretos. El marcador de logrotate permite revisar a diario la retención sin mover
el JSONL que el servicio esté escribiendo.

El ejemplo consulta las tramas de cada equipo cada 60 s y limita las consultas a
`tbl_cadena` a 3 por segundo para proteger la BD de producción. La ventana de ACK
es de 150 s: cubre el reporte de 60 s del equipo, el siguiente turno de consulta
y 30 s adicionales. Si se reduce esa ventana, el servicio registra `config_warning`
para señalar el riesgo de retransmitir antes de poder leer el ACK.

```bash
sudo install -o root -g root -m 0644 /opt/gtlock-middleware/current/deploy/gtlock-middleware.service /etc/systemd/system/gtlock-middleware.service
sudo install -o root -g root -m 0644 /opt/gtlock-middleware/current/deploy/gtlock-middleware.env.example /etc/gtlock-middleware/gtlock.env
sudo install -o root -g root -m 0644 /opt/gtlock-middleware/current/deploy/gtlock-audit.logrotate /etc/logrotate.d/gtlock-audit
sudo install -o gtlock -g gtlock -m 0600 /dev/null /var/lib/gtlock-middleware/audit/.retention
sudo restorecon -Rv /etc/systemd/system/gtlock-middleware.service /etc/gtlock-middleware /etc/logrotate.d/gtlock-audit /var/lib/gtlock-middleware
sudo systemctl daemon-reload
sudo logrotate -d /etc/logrotate.d/gtlock-audit
```

El modo `-d` revisa la configuración sin ejecutar la rotación. La retención comprime
los JSONL tras 7 días y borra los comprimidos tras 365; infraestructura fija la
política definitiva.

## 7. Primer arranque en modo sombra

Cambie `COMMAND_DRY_RUN=false` por `true` antes de arrancar. La aplicación leerá
asignaciones y producirá auditoría, pero no enviará comandos a la API.

```bash
sudo sed -i 's/^COMMAND_DRY_RUN=false$/COMMAND_DRY_RUN=true/' /etc/gtlock-middleware/gtlock.env
sudo systemctl enable --now gtlock-middleware
sudo systemctl status gtlock-middleware --no-pager
sudo journalctl -u gtlock-middleware -n 100 --no-pager
```

## 8. Validar el modo sombra

- Compruebe en `journalctl -u gtlock-middleware -f` que el arranque informa la
  configuración redactada y `shadow_mode_active`, sin secretos.
- Compruebe un `heartbeat` cada 60 s y asignaciones vigentes que llegan a
  `AWAITING_ACK`. Si no aparecen rutas, revise empresas habilitadas y conexión BD.
- Inspeccione `sudo ls -l /var/lib/gtlock-middleware/audit/` y los registros
  `INTENT` y `RESULT` con `dryRun: true`. Compare un comando de punto byte a byte
  con el formato de la spec 003 antes de habilitar envíos.
- Revise alertas sostenidas y `chain_alert`; resuelva problemas de partición con
  ElevenMinds. Confirme con el responsable de la API que no hubo llamadas.
- Ejecute `sudo ausearch -m avc -ts recent`; resuelva cualquier bloqueo SELinux.
- Verifique en Valkey la cola BullMQ y el avance de rutas. Esta comprobación
  valida la compatibilidad de la versión instalada de Valkey con BullMQ.

## 9. Pasar la unidad de pruebas a modo real

Use primero `ENABLED_COMPANIES=364:2`. Detenga el servicio para que no genere
nuevos estados. Separe la auditoría sombra y elimine estados de ruta, cursores y
colas de prueba antes de habilitar envíos; así no se retransmite un comando sombra.

```bash
sudo systemctl stop gtlock-middleware
sudo install -d -o gtlock -g gtlock -m 0750 /var/lib/gtlock-middleware/audit/shadow
sudo find /var/lib/gtlock-middleware/audit -maxdepth 1 -name 'audit-*.jsonl*' -exec mv --backup=numbered -t /var/lib/gtlock-middleware/audit/shadow -- {} +
valkey-cli --askpass --scan --pattern 'route:*'
valkey-cli --askpass --scan --pattern 'device-route:*'
valkey-cli --askpass --scan --pattern 'chain-cursor:*'
valkey-cli --askpass --scan --pattern 'bull:*'
```

Después de revisar que las llaves pertenecen a esta aplicación, elimínelas en
Valkey. `EVAL` ejecuta `SCAN` y `DEL` en el servidor sin pasar la contraseña en
argumentos; la consulta anterior muestra los mismos cuatro patrones. No use esta
secuencia si otra aplicación comparte esa instancia de Valkey.

```bash
valkey-cli --askpass EVAL 'local n=0; for _,p in ipairs(ARGV) do local c="0"; repeat local r=redis.call("SCAN",c,"MATCH",p,"COUNT",1000); c=r[1]; for _,k in ipairs(r[2]) do n=n+redis.call("DEL",k) end until c=="0" end; return n' 0 'route:*' 'device-route:*' 'chain-cursor:*' 'bull:*'
sudo sed -i 's/^COMMAND_DRY_RUN=true$/COMMAND_DRY_RUN=false/' /etc/gtlock-middleware/gtlock.env
sudo systemctl start gtlock-middleware
sudo journalctl -u gtlock-middleware -n 100 --no-pager
```

`DEL` debe terminar antes del arranque. Compruebe los primeros comandos y ACK en
la auditoría y la API con el responsable del sistema.

## 10. Pasar a producción

Tras validar la unidad de pruebas, detenga el servicio y repita el resguardo de
auditoría y la limpieza de los cuatro patrones del paso 9. Cambie entonces las
empresas habilitadas y arranque. Esto evita mezclar estado de pruebas con producción.

```bash
sudo systemctl stop gtlock-middleware
sudo install -d -o gtlock -g gtlock -m 0750 /var/lib/gtlock-middleware/audit/shadow
sudo find /var/lib/gtlock-middleware/audit -maxdepth 1 -name 'audit-*.jsonl*' -exec mv --backup=numbered -t /var/lib/gtlock-middleware/audit/shadow -- {} +
valkey-cli --askpass --scan --pattern 'route:*'
valkey-cli --askpass --scan --pattern 'device-route:*'
valkey-cli --askpass --scan --pattern 'chain-cursor:*'
valkey-cli --askpass --scan --pattern 'bull:*'
valkey-cli --askpass EVAL 'local n=0; for _,p in ipairs(ARGV) do local c="0"; repeat local r=redis.call("SCAN",c,"MATCH",p,"COUNT",1000); c=r[1]; for _,k in ipairs(r[2]) do n=n+redis.call("DEL",k) end until c=="0" end; return n' 0 'route:*' 'device-route:*' 'chain-cursor:*' 'bull:*'
sudo sed -i 's/^ENABLED_COMPANIES=364:2$/ENABLED_COMPANIES=364:1/' /etc/gtlock-middleware/gtlock.env
sudo systemctl start gtlock-middleware
```

## 11. Actualizar o revertir

Construya y verifique el nuevo artefacto con el paso 4, extráigalo en otra carpeta
de `releases/` y cambie el enlace. Reiniciar carga el nuevo código; la versión
anterior queda disponible. Para revertir, apunte al directorio previo y reinicie.

```bash
sudo systemctl stop gtlock-middleware
sudo ln -s /opt/gtlock-middleware/releases/<version> /opt/gtlock-middleware/current.new
sudo mv -Tf /opt/gtlock-middleware/current.new /opt/gtlock-middleware/current
sudo systemctl start gtlock-middleware
sudo journalctl -u gtlock-middleware -n 100 --no-pager
```

## 12. Parar y diagnosticar

```bash
sudo systemctl stop gtlock-middleware
sudo systemctl status gtlock-middleware --no-pager
sudo journalctl -u gtlock-middleware -n 200 --no-pager
sudo systemctl show gtlock-middleware -p ExecMainStatus -p Result
```

`stop` permite un apagado ordenado; una ruta pendiente se recupera al arrancar.
Código `0`: salida normal. Código `1`: fallo de arranque o error inesperado; revise
los logs y la disponibilidad de BD, API y Valkey. Código `78`: configuración
inválida; corrija entorno o credenciales y arranque manualmente, pues systemd no
reinicia automáticamente ese código. Revise también `sudo ausearch -m avc -ts recent`
si faltan accesos en SELinux.

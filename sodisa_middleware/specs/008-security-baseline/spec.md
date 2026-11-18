# Spec 008 — Línea base de seguridad y despliegue (systemd, sin conexión a internet)

> Carpeta `specs/008-security-baseline`; artefactos en `deploy/` y `scripts/`.
> Esta versión **reemplaza** cualquier borrador anterior de la carpeta.

## Objetivo
Definir y versionar cómo se construye, se instala y se opera el servicio en el servidor
(CentOS Stream 10, systemd 257, SELinux en modo `Enforcing`, **sin acceso a internet**):
como servicio nativo de systemd bajo un usuario dedicado sin privilegios (`gtlock`), con los
secretos entregados por `LoadCredential`, endurecido, con despliegue reversible y con un
procedimiento escrito para instalar, pasar del modo sombra al modo real, rotar secretos y detenerlo.

## Fuera de alcance
- Lógica del servicio (001 a 007) y su arranque (spec 006).
- Reglas de firewall y la ruta de actualizaciones de seguridad del sistema operativo: se documentan los requisitos; las define infraestructura.
- Rutas desordenadas → spec 009.

## Hechos del servidor (verificados)
- CentOS Stream 10; `systemd 257`; SELinux `Enforcing`.
- Sin acceso a los espejos de paquetes ni al registro de npm.
- Alcanza la base de datos (`192.168.20.20:5500`) y la API (`metrics.globaltrack.com.mx` resuelve a `192.168.24.44`, puerto 443).
- Sin Node ni Redis/Valkey instalados al iniciar. Repositorios disponibles: `appstream`, `baseos` (sin red) y los de Google.
- El usuario `axfgtmx` tiene `sudo` sin contraseña y pertenece a `docker` y `lxd`: **no** es el usuario del servicio.

## Entregables
| Archivo | Contenido |
|---|---|
| `deploy/gtlock-middleware.service` | Unidad de systemd. |
| `deploy/gtlock-middleware.env.example` | Variables **no secretas** para `/etc/gtlock-middleware/gtlock.env`. |
| `deploy/valkey-gtlock.conf` | Fragmento de configuración de Valkey (persistencia y red). |
| `deploy/gtlock-audit.logrotate` | Retención de los archivos de auditoría. |
| `deploy/README.md` | Procedimiento operativo completo, con el porqué de cada paso. |
| `scripts/package-release.mjs` y script `npm run package` | Construye el artefacto de despliegue. |

## Disposición en el servidor
| Ruta | Dueño y permisos | Uso |
|---|---|---|
| `/opt/gtlock-middleware/releases/<versión>/` | `root:root`, solo lectura para los demás | Una carpeta por versión desplegada. |
| `/opt/gtlock-middleware/current` | enlace simbólico a la versión activa | Despliegue y reversión cambiando el enlace. |
| `/etc/gtlock-middleware/gtlock.env` | `root:root`, `0644` | Variables no secretas. |
| `/etc/gtlock-middleware/credentials/` | `root:root`, `0700`; cada archivo `0600` | `command-api-key`, `database-url` y `redis-url`. |
| `/var/lib/gtlock-middleware/` | `gtlock:gtlock`, `0750` (lo crea systemd con `StateDirectory`) | `audit/`. |

**Usuario del servicio:** `gtlock`, usuario de sistema, sin contraseña, sin shell de acceso (`/usr/sbin/nologin`), sin directorio personal propio y **sin pertenecer a ningún grupo extra** (ni `sudo`, ni `docker`, ni `adm`). Se crea con `useradd --system --user-group --no-create-home --home-dir /var/lib/gtlock-middleware --shell /usr/sbin/nologin gtlock`. `axfgtmx` es quien instala y administra (con `sudo`); no ejecuta el servicio.
Los archivos de credenciales los lee **systemd como root** y los entrega al proceso en un directorio temporal en memoria (`$CREDENTIALS_DIRECTORY`); `gtlock` no necesita leer `/etc/gtlock-middleware/credentials/`.

## Artefacto de despliegue (`npm run package`)
Como el servidor no llega a npm, el artefacto lleva todo lo necesario para ejecutarse:
- Contenido (lista cerrada): `dist/`, `package.json`, `package-lock.json`, `node_modules/` **solo de producción** y `deploy/`. Nada más (ni `src/`, `specs/`, `legacy/`, `.env`, `audit/`, `release/`).
- El código se compila en un `dist/` temporal limpio; las dependencias se instalan en ese mismo directorio temporal con `npm ci --omit=dev --omit=optional --ignore-scripts`, para no incluir salidas antiguas ni binarios de otra plataforma.
- El script falla si encuentra algún archivo `*.node` (módulo nativo) en `node_modules/`.
- Salida: `release/gtlock-middleware-<versión>-<commit>.tar.gz` y su archivo `.sha256`. La versión sale de `package.json` y el commit de `git rev-parse --short HEAD`; con cambios sin confirmar, el script avisa y agrega `-dirty` al nombre.

## Unidad de systemd (requisitos)
- `User=gtlock`, `Group=gtlock`, `Type=simple`, `WorkingDirectory=/opt/gtlock-middleware/current`, `ExecStart=/usr/bin/node /opt/gtlock-middleware/current/dist/main.js`.
- `EnvironmentFile=/etc/gtlock-middleware/gtlock.env`.
- `LoadCredential=command-api-key:/etc/gtlock-middleware/credentials/command-api-key`, `LoadCredential=database-url:/etc/gtlock-middleware/credentials/database-url` y `LoadCredential=redis-url:/etc/gtlock-middleware/credentials/redis-url` (los nombres que lee la spec 006).
- `StateDirectory=gtlock-middleware`; `AUDIT_LOG_DIR=/var/lib/gtlock-middleware/audit` en el archivo de entorno.
- Reinicio: `Restart=always`, `RestartSec=5`, **`RestartPreventExitStatus=78`**.
- Apagado: `TimeoutStopSec=40` (mayor que el límite de 25 s de la spec 006), `KillSignal=SIGTERM`.
- Orden de arranque: `After=network-online.target valkey.service` y `Wants=network-online.target`. Solo ordena el arranque: **no** hay `Requires`, así que si Valkey tarda, el arranque del servicio falla y el reinicio automático reintenta.
- Endurecimiento: `NoNewPrivileges=yes`, `ProtectSystem=strict`, `ProtectHome=yes`, `PrivateTmp=yes`, `PrivateDevices=yes`, `ProtectKernelTunables=yes`, `ProtectKernelModules=yes`, `ProtectControlGroups=yes`, `RestrictAddressFamilies=AF_INET AF_INET6 AF_UNIX`, `RestrictNamespaces=yes`, `LockPersonality=yes`, `UMask=0077`. La única ruta escribible es la de `StateDirectory`.
- Los logs van a la salida estándar (journald). El servicio no abre puertos.

## Valkey (el Redis de CentOS Stream 10)
En esta distribución el repositorio ofrece **Valkey 8.0** en lugar de Redis; es compatible con el protocolo y el servicio sigue usando `ioredis`. `REDIS_URL` es un secreto de la spec 006, entregado como credencial `redis-url`, con formato `redis://:<valor>@127.0.0.1:6379`.
`deploy/valkey-gtlock.conf` fija: `bind 127.0.0.1 -::1`, `protected-mode yes`, `port 6379`, `appendonly yes`, `maxmemory-policy noeviction`, y añade `include /etc/valkey/gtlock-auth.conf`. El archivo incluido se crea solo en el servidor con `requirepass <valor>`, propiedad `root:valkey` y permisos `0640`; no se versiona. Los nombres del servicio, la configuración y la herramienta de línea de comandos (`valkey.service`, `/etc/valkey/valkey.conf`, `valkey-cli`) son los esperados; el README incluye el paso para confirmarlos con `rpm -ql valkey` antes de usarlos.
BullMQ no certifica Valkey de forma oficial (sus autores lo probaron en 7.2, 8.1 y 9.0): se verifica en el despliegue sombra. Si fallara, la alternativa es Redis desde otra fuente.

## Requisitos de red (solo salida)
| Destino | Puerto | Para |
|---|---|---|
| PostgreSQL `192.168.20.20` | `5500` | Asignaciones, catálogo y tramas. |
| `metrics.globaltrack.com.mx` (hoy `192.168.24.44`) | `443` | API de comandos. |
| `127.0.0.1` | `6379` | Valkey local. |
No debe haber ningún puerto de entrada abierto para este servicio.

## Secretos
- Nunca en el repositorio, en `.env`, en logs, en la auditoría ni en la línea de comandos. `REDIS_URL` es el tercer secreto junto con `COMMAND_API_KEY` y `DATABASE_URL`.
- Se crean como root, sin que el valor quede en el historial: `read -rs` y escritura con `umask 077`.
- La contraseña de Valkey se genera con `openssl rand -hex 32` (hexadecimal para no codificarla en la URL), se escribe en `/etc/valkey/gtlock-auth.conf` como `requirepass <valor>` y en la credencial `redis-url` como `redis://:<valor>@127.0.0.1:6379`.
- **Rotación:** reemplazar el archivo y `systemctl restart gtlock-middleware`. La clave nueva de la API la emite el responsable de la API; la contraseña de la BD, ElevenMinds.
- `.gitignore` incluye `.env`, `audit/`, `release/`, `*.key` y `credentials/`.

## Procedimiento operativo (`deploy/README.md` debe cubrir, explicando el porqué de cada paso)
0. **Verificación previa en el servidor:** `uname -m` (debe ser `x86_64`), `timedatectl` (reloj sincronizado), `getenforce`, espacio en disco.
1. **Paquetes sin conexión:** en una máquina con internet y Docker (la del desarrollador): descargar con un contenedor `quay.io/centos/centos:stream10` los RPM de `nodejs` y `valkey` **con sus dependencias** (`dnf download --resolve --alldeps`); si no hay Docker, quien tenga una máquina CentOS Stream 10 con internet ejecuta el mismo comando. Subir los RPM por `scp`, verificar su firma (`rpm -K`) e instalarlos sin repositorios (`dnf install --disablerepo='*' ./*.rpm`). Plan B documentado si falta alguna dependencia (`rpm -qpR`).
2. **Usuario y directorios:** crear `gtlock` y los directorios con los permisos de la tabla; etiquetas de SELinux (`restorecon -Rv`).
3. **Valkey:** instalar el fragmento de configuración y crear `/etc/valkey/gtlock-auth.conf` con contraseña generada; habilitar y arrancar; comprobar con `valkey-cli --askpass ping`, `CONFIG GET appendonly` y `CONFIG GET maxmemory-policy` usando `--askpass`.
4. **Artefacto:** construirlo en la máquina de desarrollo (`npm run package`), subirlo por `scp`, verificar `sha256sum -c`, extraerlo en `releases/<versión>` y apuntar `current` a esa carpeta.
5. **Secretos:** crear los tres archivos de credencial, incluido `redis-url` con la misma contraseña de Valkey.
6. **Unidad y variables:** instalar la unidad, el archivo de entorno y la retención; `systemctl daemon-reload`.
7. **Primer arranque en modo sombra** (`COMMAND_DRY_RUN=true`).
8. **Revisión del modo sombra** (lista de comprobación):
   - El log de arranque muestra la configuración **sin secretos** y `shadow_mode_active`.
   - Hay un `heartbeat` cada 60 s.
   - Las asignaciones vigentes de las empresas habilitadas se detectan y las rutas llegan a `AWAITING_ACK`.
   - La auditoría contiene `INTENT` y `RESULT` con `dryRun: true`; el comando de un punto coincide byte a byte con el formato de la spec 003.
   - No hay alertas de error sostenidas; las de partición (`chain_alert`) se entienden o se resuelven con ElevenMinds.
   - No hubo llamadas a la API (se confirma con el responsable de la API).
   - `sudo ausearch -m avc -ts recent` no muestra bloqueos de SELinux.
9. **Paso a modo real** (primero con la unidad de pruebas, `ENABLED_COMPANIES=364:2`): detener el servicio; mover `audit-*.jsonl` de la fase sombra a `audit/shadow/`; borrar de Valkey las llaves `route:*`, `device-route:*`, `chain-cursor:*` y `bull:*` (consultas autenticadas con `valkey-cli --askpass --scan --pattern '<patrón>'` y borrado con `DEL`); poner `COMMAND_DRY_RUN=false`; arrancar. Así ningún estado de la fase sombra se retransmite como comando real.
10. **Producción** (`364:1`): mismo procedimiento, tras validar la unidad de pruebas.
11. **Actualizar o revertir:** subir una versión nueva, cambiar `current`, reiniciar; para revertir, volver a apuntar `current` a la versión anterior y reiniciar.
12. **Parada y diagnóstico:** `systemctl stop gtlock-middleware` (apagado ordenado; una ruta en curso se retoma al volver a arrancar); `journalctl -u gtlock-middleware`; códigos de salida (0 normal, 1 fallo en arranque o error no capturado, 78 configuración inválida) y qué hacer con cada uno.

## Retención de la auditoría
`gtlock-audit.logrotate` ejecuta a diario la retención sobre `/var/lib/gtlock-middleware/audit/audit-*.jsonl` mediante un marcador vacío `.retention`: los archivos ya son diarios, así que solo se comprimen los de más de 7 días y se eliminan los de más de 365, sin renombrar el JSONL activo. El README crea el marcador. Los valores se pueden cambiar; la retención oficial la define infraestructura.

## Criterios de aceptación
- [ ] La unidad contiene todas las directivas de “Unidad de systemd”, con `User=gtlock`, las tres `LoadCredential` con los nombres que lee la spec 006 y `RestartPreventExitStatus=78`; `TimeoutStopSec` es mayor que 25.
- [ ] Ni la unidad, ni el archivo de entorno de ejemplo, ni el fragmento de Valkey, ni el README contienen secretos reales; el archivo de ejemplo no incluye `COMMAND_API_KEY` ni `DATABASE_URL`.
- [ ] El archivo de ejemplo contiene todas las variables no secretas de `docs/architecture.md` §7 con sus valores por defecto y `AUDIT_LOG_DIR=/var/lib/gtlock-middleware/audit`; no incluye `REDIS_URL`.
- [ ] `deploy/valkey-gtlock.conf` fija las cinco directivas indicadas e incluye `/etc/valkey/gtlock-auth.conf` sin contraseña versionada.
- [ ] `npm run package` genera el `.tar.gz` y su `.sha256`, con solo el contenido de la lista cerrada, y falla si hay archivos `*.node`.
- [ ] La lista de contenido del artefacto está probada por una prueba unitaria (sin ejecutar `npm ci` ni red).
- [ ] `.gitignore` excluye `.env`, `audit/`, `release/`, `*.key` y `credentials/`.
- [ ] El README cubre los pasos 0 a 12, con comandos exactos, el porqué de cada paso y la lista de comprobación del modo sombra.
- [ ] `npm audit --omit=dev` se ejecuta y su resultado se reporta (sin aplicar correcciones automáticas).
- [ ] Una prueba lee `deploy/gtlock-middleware.service` y verifica las tres `LoadCredential`, las directivas obligatorias y la ausencia de patrones de secreto.

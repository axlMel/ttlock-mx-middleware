# Plan 008 — Línea base de seguridad y despliegue

## Decisiones
1. **Usuario dedicado `gtlock`, sin privilegios.** El usuario administrador (`axfgtmx`) tiene `sudo` sin contraseña y pertenece a `docker` y `lxd`: ejecutar el servicio con él haría que un compromiso del proceso fuera un camino a root. `gtlock` no puede iniciar sesión, no tiene grupos extra y solo escribe en `/var/lib/gtlock-middleware`.
2. **`LoadCredential` con archivos de root.** Los tres secretos (`command-api-key`, `database-url`, `redis-url`) sobreviven a los reinicios, nunca pasan por el entorno ni por el repositorio, y el usuario del servicio no puede leer los archivos originales (los recibe en un directorio en memoria).
3. **Instalación sin conexión.** El servidor no llega a los espejos ni a npm; los paquetes del sistema se descargan en una máquina con internet y se instalan desde archivos locales verificando su firma. Queda como pendiente para infraestructura una ruta de actualizaciones de seguridad del sistema operativo.
4. **Artefacto autocontenido** con `node_modules` de producción, construido sin dependencias opcionales y sin scripts de instalación, para que no lleve binarios de la plataforma del desarrollador. La compilación va a un `dist/` temporal limpio para no arrastrar archivos de builds anteriores. El script falla si aparece algún `*.node`.
5. **Versiones con enlace simbólico `current`.** Desplegar y revertir es cambiar un enlace y reiniciar; nunca se sobrescribe lo que está corriendo.
6. **Valkey en lugar de Redis**, por ser el paquete del repositorio de la distribución. La contraseña se genera una vez en hexadecimal; el archivo de autenticación local se incluye desde la configuración de Valkey y la URL con esa contraseña se entrega a 006 mediante la credencial `redis-url`.
7. **`After=valkey.service` sin `Requires`.** Ordena el arranque sin acoplar el ciclo de vida: si Valkey se reinicia, el servicio sigue y se reconecta.
8. **Código 78 sin reinicio** (`RestartPreventExitStatus=78`): un error de configuración se corrige a mano.
9. **Limpieza de Valkey al salir del modo sombra**, para que ningún estado de la fase sombra se retransmita como comando real.
10. **Lo verificable se prueba en el repositorio** (directivas de la unidad, lista de contenido del artefacto); lo demás es una lista de comprobación del README, porque no hay pruebas locales.
11. **Retención sin renombrar el archivo activo.** `logrotate` rota a diario un archivo marcador vacío y ejecuta `find` sobre `audit-*.jsonl`: comprime tras 7 días y elimina los `.gz` tras 365 días. El README crea el marcador; así el mantenimiento corre aun cuando no haya archivos recientes y no mueve un JSONL que la aplicación pueda seguir escribiendo.

## Estructura
```
deploy/
  gtlock-middleware.service
  gtlock-middleware.env.example
  valkey-gtlock.conf
  gtlock-audit.logrotate
  README.md
scripts/package-release.mjs
(prueba de la unidad y de la lista de contenido, junto a la configuración de Jest del proyecto)
.gitignore                (entradas nuevas)
package.json              (script "package")
```

## Orden de trabajo
Revisar lo previo → unidad → archivo de entorno → fragmento de Valkey → logrotate → script de empaquetado (con la función de lista de contenido separada y probada) → `.gitignore` y script `package` → README → pruebas → `npm audit`.

## Riesgos
- Dependencias de los RPM: `--alldeps` descarga el cierre completo, que puede incluir paquetes ya instalados; la instalación local los omite. El README documenta el plan B.
- Nombres de servicio y de comandos de Valkey: se confirman con `rpm -ql valkey` en el paso 3 antes de usarlos.
- SELinux en `Enforcing`: la unidad no debería chocar, pero el paso de revisión incluye `ausearch` para detectarlo.
- BullMQ sobre Valkey: se valida en el despliegue sombra.

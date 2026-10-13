# Spec 006 — Arranque de la aplicación

## Objetivo

Proveer un punto de entrada ejecutable que conecte las implementaciones reales
de 001 a 005, arranque el orquestador y mantenga el proceso activo mientras
BullMQ ejecuta el drenaje inicial, los pollers y la reanudación de rutas.

## Entradas

- `DATABASE_URL` y `REDIS_URL`, obligatorias y no vacías.
- `POLL_INTERVAL_MS_ROUTES`, `POLL_INTERVAL_MS_ACK`, `ACK_MAX_RETRIES` y
  `ACK_RETRY_BACKOFF_MS`, con las reglas de validación de 002: intervalos y
  backoff enteros positivos; `ACK_MAX_RETRIES` entero no negativo.
- Señales de proceso `SIGINT` y `SIGTERM`.
- En desarrollo, un archivo `.env` local como fuente de las mismas variables
  mediante la función nativa `--env-file` de Node.

## Comportamiento

1. Validar la configuración antes de iniciar el worker. Si falta una variable
   obligatoria o un valor es inválido, registrar un error comprensible y
   terminar con estado distinto de cero, sin iniciar los pollers.
2. Abrir las conexiones necesarias a PostgreSQL y Redis. PostgreSQL se usa
   exclusivamente en consultas de solo lectura; Redis aloja el estado, el
   cursor y la cola. No registrar URL, usuario ni contraseña.
3. Instanciar los detectores de rutas y reportes (001), el directorio de
   dispositivos (005), los almacenes de estado y cursor (004), y arrancar el
   worker de BullMQ/orquestador (002) con el protocolo real (003). El arranque
   de 002 programa el drenaje inicial si no hay cursor, los pollers y la
   reanudación de estados persistidos según su propia spec. No duplicar esas
   reglas en 006.
4. Registrar en español el inicio, la disponibilidad del worker, los errores
   de arranque y el apagado, siempre con timestamp. Un log de disponibilidad
   significa que el trabajo inicial quedó programado; el drenaje y las
   consultas se ejecutan después en BullMQ.
5. Ante `SIGINT` o `SIGTERM`, iniciar un único apagado ordenado: cerrar el
   worker y su cola, después los clientes de PostgreSQL y Redis propiedad del
   punto de entrada. Esperar los cierres antes de terminar. Si un cierre
   falla, registrar el error, intentar cerrar los demás recursos y terminar
   con estado distinto de cero. Aplicar el mismo criterio a un fallo durante
   el arranque después de crear recursos.

## Salidas

- Proceso en ejecución con los jobs de 002 programados y sus conexiones
  abiertas mientras esté activo.
- Código de salida cero tras un apagado ordenado completo; distinto de cero
  ante configuración inválida, fallo de arranque o fallo de cierre.

## Casos borde

- Señales repetidas durante el cierre no ejecutan el cierre dos veces.
- Si llega una señal durante la preparación de las conexiones, el proceso
  espera el resultado de ese arranque y cierra los recursos que se hayan
  creado; no inicia un segundo arranque.
- Una conexión o el worker puede fallar después de que otras conexiones ya
  existan; los recursos abiertos se liberan igualmente.
- Si el cursor y los estados ya existen en Redis, 002 los usa para reanudar
  sin duplicar cadenas de reintento; 006 no borra ni reinicia esos datos.

## Fuera de alcance

- Nuevas transiciones de FSM, nuevas consultas SQL, cambios de protocolo o
  de política de polling/reintentos.
- Sockets UDP de escucha, endpoints HTTP, panel de cola o monitoreo nuevo.
- Cambiar el esquema de la BD externa o escribir en ella.
- Gestión de secretos fuera de variables de entorno y del `.env` local.

## Criterios de aceptación

- [ ] `npm run dev` carga el `.env` local mediante Node y arranca el proceso;
      `npm start` arranca con variables ya presentes en el entorno.
- [ ] Configuración ausente o inválida produce un error en español y salida
      distinta de cero antes de arrancar BullMQ.
- [ ] El punto de entrada conecta las implementaciones reales de 001 a 005;
      el arranque invoca una sola vez la rutina de 002 que programa drenaje,
      pollers y reanudación.
- [ ] `SIGINT` y `SIGTERM` cierran worker/cola, ambos clientes PostgreSQL
      usados por los módulos y las conexiones Redis; señales repetidas son
      idempotentes y un fallo de cierre no impide cerrar lo demás.
- [ ] Los logs de arranque/apagado incluyen timestamp y no exponen secretos.
- [ ] No se abre ningún socket UDP de escucha ni se añade lógica de negocio.
- [ ] `npm test` y `npm run lint` pasan, incluidas las pruebas existentes.

# Plan — 004-state-persistence
 
## Estructura de archivos
```
src/persistence/
  types.ts             // RouteState, FsmState
  routeStateStore.ts   // implementación con ioredis
  cursorStore.ts       // implementación con ioredis
  persistence.test.ts  // tests
```
 
## Decisiones técnicas
- **Cliente Redis: `ioredis`.** No es una dependencia nueva de verdad —
  BullMQ ya depende de `ioredis` internamente, así que instalarlo aquí no
  añade una pieza móvil adicional al proyecto (principio I).
- **Serialización:** `JSON.stringify`/`JSON.parse` para `RouteState`. El
  cursor es un string plano, sin serialización.
- **Enumeración de estados:** `RouteStateStore.list()` recorre las llaves
  `route:*` con `SCAN` y lee sus valores; evita `KEYS` y no amplía el acceso
  a la BD externa. `lastCommandSentAt` es `null` hasta el primer envío.
- **Persistencia de Redis (`appendonly yes`) es responsabilidad de
  infraestructura, no de este código.** Se documenta como requisito de
  despliegue en `docs/architecture.md` para que Ever lo configure en el
  servidor — el módulo asume que Redis ya persiste, no lo verifica en
  tiempo de ejecución.
- **Sin TTL en `RouteState`** en esta iteración. Con 150 dispositivos en
  producción esto podría requerir limpieza periódica de rutas completadas
  muy viejas — no es un problema con 1 dispositivo de prueba, se revisita
  cuando la spec de escalamiento lo amerite (no ahora, principio I).
## Testing
- **`ioredis-mock`** como devDependency — permite testear sin depender de
  un Redis real corriendo en CI. Es la única dependencia nueva de este
  módulo, justificada explícitamente para evitar infraestructura extra en
  pruebas automatizadas.
- Casos de test:
  1. Guardar `RouteState` y leerlo de vuelta idéntico.
  2. Leer un `deviceId` sin estado guardado → `null`.
  3. Eliminar un estado y confirmar que el siguiente `get` es `null`.
  4. Guardar y leer un cursor.
  5. Leer un cursor de una fuente sin valor guardado → `null`.
  6. Listar varios estados, comprobar lista vacía y reflejar una eliminación.
## Alternativas descartadas
- **SQLite local:** descartado. Ya existe Redis por BullMQ; añadir SQLite
  sería una segunda pieza de persistencia sin necesidad real (principio I).
- **Guardar el cursor en una tabla nueva de la BD externa** (sugerencia
  original de Gustavo): descartado explícitamente. Viola el principio V
  (no mezclar estado propio con datos de origen) y resuelve con una pieza
  nueva un problema que la herramienta que ya tienen (Redis) resuelve mejor.

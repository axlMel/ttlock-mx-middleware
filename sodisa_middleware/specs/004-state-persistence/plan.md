# Plan — 004-state-persistence

## Estructura de archivos
```
src/persistence/
  types.ts                 // RouteState, ChainCursor, CatalogEntry y errores
  keys.ts                  // única fuente del formato de llaves de Redis
  routeStateStore.ts
  chainCursorStore.ts      // reemplaza a cursorStore.ts
  catalogCacheStore.ts
  index.ts                // entrada pública de tipos, interfaces e implementaciones
  persistence.test.ts
```

## Decisiones técnicas
- **Sin dependencias nuevas.** `ioredis` e `ioredis-mock` ya están instaladas por la versión anterior de este módulo (principio I).
- **El cliente de Redis se inyecta** en el constructor de cada store (`new RouteStateStore(redis, options?)`). El módulo no crea conexiones; en las pruebas recibe `ioredis-mock` (principio III).
- **Serialización:** `JSON.stringify` y `JSON.parse`. Las fechas son cadenas ISO, como en `types.ts`.
- **`keys.ts`:** funciones `routeKey(id)`, `deviceRouteKey(id)`, `chainCursorKey(id)` y `catalogKey(entity, id)`. Ningún otro archivo arma llaves a mano.
- **Transacción:** `set` y `delete` de `RouteStateStore` usan `redis.multi()...exec()` para mantener `route:` y `device-route:` consistentes. Si `ioredis-mock` no soporta `multi`, se usa `pipeline` solo en las pruebas y se deja anotado aquí.
- **`list()`:** bucle de `scan` con `MATCH route:*` y `COUNT 100` hasta que el cursor vuelva a `'0'`; cada llave se filtra con `^route:[0-9]+$`, de modo que `device-route:` nunca entra.
- **Valores corruptos:** `CorruptStateError` en `get` y `getByDevice`; `list()` omite la llave y llama a `onCorrupt` (opción del constructor, opcional). Así un dato dañado no detiene el arranque del orquestador (principio VII).
- **Sin TTL.** La vigencia de la caché de catálogo la gestiona el módulo 005.
- **Marcas por partición y hora de envío.** `ChainCursor` conserva `previous` como marca opcional con `hasMore` en el mismo JSON, para terminar lotes anteriores llenos después de la ventana; `RouteState` conserva `firstTransmissionAt` por paso. Al leer JSON anterior, se interpretan ambos campos ausentes como `null`, sin migración de llaves. Se evita que la lectura de una partición adelante la marca de otra.
- **Se elimina:** `PollingCursorStore` (el cursor ahora es por equipo) y el `RouteState` antiguo. Solo los usaba el código estacionado en `legacy/`.

## Pruebas
- Jest con `ioredis-mock`. Sin red, sin BD y sin Docker.
- Casos de `RouteStateStore`: guardar y leer; inexistente → `null`; `getByDevice`; `delete` limpia las dos llaves; `list()` devuelve varias rutas y excluye `device-route:`; JSON corrupto (`get` lanza, `list` omite y avisa).
- Casos de `ChainCursorStore` y `CatalogCacheStore`: guardar, leer, borrar, inexistente → `null`.
- Ida y vuelta de las dos marcas y de `firstTransmissionAt`, incluida lectura de JSON anterior sin esos campos.
- Una prueba comprueba que `routeType` hace el viaje completo de ida y vuelta.
- Una prueba comprueba, en tipos o en datos, que `FsmState` no incluye `FAILED` ni `PAUSED`.

## Alternativas descartadas
- **Hash de Redis (`HSET`) por ruta:** permite leer campos sueltos, pero nadie los necesita; un `SET` con JSON es más simple y se escribe de una sola vez.
- **Guardar el cursor dentro del `RouteState`:** el cursor se actualiza en cada ciclo de lectura y el estado lo cambia la FSM; en una sola llave competirían por escribir. Llaves separadas evitan esa contención.
- **Guardar el `deviceId` solo dentro del JSON:** no permitiría buscar la ruta de un equipo sin recorrer todas. Por eso existe el índice `device-route:`.
- **Redis Streams o listas para la caché:** no hay un caso que las pida hoy (principio I).

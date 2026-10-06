# Spec 005 — Device Directory (resolución IMEI → modelo/IP/puerto)

## Objetivo
Resolver, a partir de un IMEI, los datos necesarios para dirigir un comando
de configuración al dispositivo correcto: modelo, IP y puerto de escucha.

## Fuera de alcance
- Armado/envío de comandos → `specs/003`.
- Persistencia de estado de ruta → `specs/004`.

## Esquema de origen (ASUMIDO — pendiente de confirmación formal)
Tabla `resumen_unidad` con columnas `imei, modelo, ip, puerto`, replicada
en la BD local de desarrollo (ver `docs/architecture.md`). Cuando el
equipo de BD confirme el esquema real, solo se ajusta la consulta en
`plan.md` — la interfaz pública de este módulo no cambia.

## Interfaz
```typescript
interface DeviceDirectoryEntry {
  imei: string;
  model: 'GV300W' | 'GV310LAU';
  ip: string;
  port: number;
}

interface DeviceDirectory {
  getDeviceInfo(imei: string): Promise<DeviceDirectoryEntry>;
}
```

## Reglas de negocio
- Si el IMEI no existe en `resumen_unidad`, lanzar `UnknownDeviceError` —
  nunca devolver un valor por default ni `null` silencioso.
- El modelo debe mapear 1:1 a un perfil de `specs/003`; si el valor de BD
  no coincide con ningún perfil conocido, lanzar error explícito también.
- El puerto se toma tal cual viene de la fuente — no se usa un mapa fijo
  por modelo en código (regla ya establecida en `AGENTS.md`).

## Criterios de aceptación
- [ ] `getDeviceInfo(imei)` devuelve el registro correcto contra la BD
      local sembrada con los 2 dispositivos de prueba reales.
- [ ] `getDeviceInfo` con un IMEI inexistente lanza `UnknownDeviceError`.
- [ ] `getDeviceInfo` con un modelo no reconocido en BD lanza error
      explícito, no un valor silencioso.
- [ ] La implementación vive detrás de la interfaz `DeviceDirectory` para
      poder sustituir la fuente de datos sin tocar el dominio.

## Fuera de alcance de esta iteración
- Caché de resultados (innecesaria con 1-2 dispositivos de prueba).
- Resolución de modelo por TAC del IMEI — descartada, la BD ya trae el modelo.
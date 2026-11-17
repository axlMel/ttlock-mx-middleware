# Constitución — gtlock-middleware

> Este documento define los principios innegociables del proyecto. No describe
> comandos, stack ni catálogo de módulos — eso vive en `AGENTS.md` y en
> `docs/architecture.md`. Un cambio aquí requiere decisión explícita del humano
> responsable del proyecto; un cambio en `AGENTS.md`, en `docs/` o en `specs/`
> nunca puede contradecir lo aquí escrito.

## I. Simplicidad del stack
El proyecto usa el **mínimo número de piezas móviles** capaz de cumplir los
requisitos de la spec activa. Ninguna dependencia, servicio externo o patrón
de diseño se incorpora "por si acaso" o "para escalar a futuro": se incorpora
cuando una spec concreta lo requiere hoy.

**Verificable:** toda dependencia nueva en `package.json` debe poder
rastrearse a una línea específica de un `plan.md` en `specs/`. Si no existe
esa referencia, la dependencia se rechaza en revisión.

## II. La spec gobierna al código, nunca al revés
El código es una consecuencia de la spec, no una fuente de verdad paralela.
Ninguna lógica de negocio (transiciones de estado, formato de comandos,
condiciones de reintento) se escribe, cambia o borra sin que exista primero
la línea correspondiente en `specs/*/spec.md`.

**Verificable:** ante cualquier discrepancia entre lo que el código hace y lo
que la spec describe, la spec gana. Se corrige el código o se corrige la
spec explícitamente — nunca se deja la discrepancia sin resolver ni se asume
que "el código manda porque ya funciona así".

## III. Separación entre lógica de dominio e interfaz técnica
La lógica de negocio (la máquina de estados, las reglas de progresión de
ruta, las condiciones de reintento) se escribe de forma que **no conozca**
los detalles del transporte, el protocolo del dispositivo ni el motor de
persistencia concretos. La interfaz técnica (clientes HTTP, drivers de base
de datos, clientes de cola) es reemplazable sin tocar la lógica de dominio.

**Verificable:** un módulo de dominio debe poder testearse unitariamente sin
levantar red, base de datos ni proceso de cola. Si un test de lógica de
negocio requiere una conexión real, el diseño viola este principio.

## IV. Política de tests
Ninguna tarea se considera terminada sin prueba automatizada que la respalde.
La cobertura de tests no es una meta numérica: es un requisito por
comportamiento — cada regla de negocio descrita en una spec tiene al menos
un test que falla si esa regla se rompe. Las pruebas automatizadas no
requieren infraestructura externa: usan clientes falsos y datos de ejemplo
reales.

**Verificable:** un `pull request` que añade o modifica comportamiento sin
tests correspondientes se rechaza, sin excepción por urgencia o tamaño del
cambio. `npm test` debe pasar en verde antes de cerrar cualquier tarea, y
debe poder ejecutarse en una máquina sin red, sin base de datos y sin Docker.

## V. Persistencia de datos: origen externo vs. estado propio
El proyecto distingue siempre entre **datos de origen** (los que llegan de
sistemas externos que el proyecto no controla) y **estado propio** (el
progreso, reintentos y decisiones que el proyecto genera). Los datos de
origen se tratan como de solo lectura sin excepción, sin importar los
permisos técnicos disponibles en un momento dado. El estado propio vive
siempre en almacenamiento controlado por el proyecto, nunca mezclado con
los datos de origen.

**Verificable:** ninguna operación de escritura del código toca jamás el
almacenamiento de origen externo. Si un cambio de infraestructura llegara a
otorgar permisos de escritura sobre ese origen, este principio sigue
aplicando igual hasta que se derogue explícitamente aquí, por escrito.

## VI. Idioma del código y los mensajes
El código (identificadores, nombres de funciones, tipos, logs internos de
depuración) se escribe en inglés, por convención de la industria y
legibilidad para cualquier colaborador futuro. Todo lo dirigido a una
persona — mensajes de error visibles, comentarios que explican una decisión
de negocio, documentación, specs — se escribe en español, el idioma del
equipo y los operadores del sistema.

**Verificable:** un mensaje de error que llega a un log operativo o a una
persona nunca está en inglés. Un identificador de código nunca está en
español. No existe mezcla dentro de una misma categoría.

## VII. Operación autónoma
El sistema corre sin interfaz ni operador. Ninguna condición anómala (error
de red, API caída, equipo sin respuesta, dato inválido) puede dejarlo en un
estado terminal de fallo ni en una pausa que dependa de una persona. Toda
anomalía produce una alerta y un reintento o una espera acotada, y nunca
afecta el trabajo de los demás equipos ni detiene el proceso. Tampoco se
salta un paso de una ruta para "seguir avanzando".

**Verificable:** el modelo de estados no contiene un estado de fallo
terminal ni de pausa (por ejemplo `FAILED` o `PAUSED`). Cada rama de error
tiene una prueba que demuestra que emite una alerta, reintenta o espera, y
deja continuar a los demás.

## VIII. Comandos físicos
Un comando que llega a un equipo real se trata con el máximo cuidado:
(a) se valida antes de armarse; (b) se registra en la auditoría **antes** de
enviarse; (c) solo se retransmite bajo una política explícita y acordada con
el dueño del canal; (d) nunca se crea una clave de idempotencia nueva para
reintentar una petición cuyo resultado es incierto; (e) la credencial del
canal nunca aparece en el repositorio ni en los logs.

**Verificable:** no existe una ruta de código que llame al canal de envío
sin pasar por la validación y por la auditoría; hay una prueba que
demuestra que, si la auditoría falla, el comando no se envía. Existe un
modo sombra que ejecuta todo el flujo sin enviar nada. Una prueba busca la
credencial en los logs y en la auditoría y no la encuentra.

## IX. Carga mínima sobre sistemas ajenos
El proyecto consulta sistemas que no controla (la base de datos de
GlobalTrack y la API de comandos) con la menor carga posible: solo lectura,
solo las columnas necesarias, sin JOINs ni `SELECT *`, solo llaves primarias
e índices existentes, nunca tablas completas, consultas parametrizadas y un
solo intento HTTP por llamada. Se guardan datos localmente en lugar de
volver a pedirlos. Cualquier excepción la autoriza por escrito el dueño del
sistema.

**Verificable:** una prueba recorre las cadenas SQL del proyecto y falla si
alguna contiene `JOIN` o `SELECT *`. Toda consulta nueva está listada en
una spec con la llave o el índice que usa.

---

*Cualquier principio de esta constitución que entre en conflicto con una
spec, con `docs/architecture.md` o con `AGENTS.md` invalida a estos, no al
revés. Si el conflicto es genuino y ambos parecen razonables, se detiene el
trabajo y se resuelve por decisión humana explícita antes de continuar.*
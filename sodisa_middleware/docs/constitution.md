# Constitución — gtlock-middleware
 
> Este documento define los principios innegociables del proyecto. No describe
> comandos, stack ni catálogo de módulos — eso vive en `AGENTS.md`. Un cambio
> aquí requiere decisión explícita del humano responsable del proyecto; un
> cambio en `AGENTS.md` o en `specs/` nunca puede contradecir lo aquí escrito.
 
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
persistencia concretos. La interfaz técnica (sockets, drivers de base de
datos, clientes de cola) es reemplazable sin tocar la lógica de dominio.
 
**Verificable:** un módulo de dominio debe poder testearse unitariamente sin
levantar red, base de datos ni proceso de cola. Si un test de lógica de
negocio requiere una conexión real, el diseño viola este principio.
 
## IV. Política de tests
Ninguna tarea se considera terminada sin prueba automatizada que la respalde.
La cobertura de tests no es una meta numérica: es un requisito por
comportamiento — cada regla de negocio descrita en una spec tiene al menos
un test que falla si esa regla se rompe.
 
**Verificable:** un `pull request` que añade o modifica comportamiento sin
tests correspondientes se rechaza, sin excepción por urgencia o tamaño del
cambio. `npm test` debe pasar en verde antes de cerrar cualquier tarea.
 
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
 
---
 
*Cualquier principio de esta constitución que entre en conflicto con una
spec o con `AGENTS.md` invalida la spec o el `AGENTS.md`, no al revés. Si el
conflicto es genuino y ambos parecen razonables, se detiene el trabajo y se
resuelve por decisión humana explícita antes de continuar.*
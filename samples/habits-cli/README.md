# Proyecto: `habits-cli`

Una app de terminal en Python para registrar hábitos de estudio y ver tu racha de días consecutivos.

## Comandos
```
habits add "estudiar python"     → crea un hábito
habits done "estudiar python"    → marca el hábito como hecho HOY
habits list                      → lista hábitos con su racha actual
```

## Estructura del proyecto

```
habits-cli/
├── AGENTS.md
├── CLAUDE.md                      # una línea: @AGENTS.md
├── docs/
│   └── constitution.md
├── specs/
│   └── 001-habits-mvp/
│       ├── spec.md
│       ├── plan.md
│       └── tasks.md
├── habits/
│   ├── __init__.py
│   ├── __main__.py
│   ├── cli.py
│   ├── core.py
│   └── storage.py
└── tests/
└── tests/
    ├── test_cli.py
    ├── test_core.py
    └── test_storage.py
```

## Uso

```bash
python -m habits add "Estudiar Python"   # crea el hábito
python -m habits done "Estudiar Python"  # lo marca como hecho HOY (idempotente)
python -m habits list                    # lista por racha descendente
```

Los datos se guardan en un único JSON legible dentro del propio proyecto:
`habits.json`, en la raíz del repositorio (ignorado por git).
Salidas: `0` si todo va bien, `1` ante cualquier error (nombre vacío, duplicado,
hábito inexistente o archivo corrupto). Un archivo corrupto nunca se sobrescribe.

## Desarrollo

```bash
python -m venv .venv && .venv/bin/pip install pytest
.venv/bin/python -m pytest -q
```

## Prompts SDD

### 1. Setup, constitución y AGENTS.md

**Constitución:**

```text
Vamos a crear la constitución de un proyecto nuevo: una CLI en Python para
registrar hábitos de estudio y calcular rachas. Es un proyecto educativo que
debe poder mantener un desarrollador junior.

Proponme un docs/constitution.md con 6 principios innegociables, cortos y
verificables, que cubran: simplicidad del stack, relación entre spec y código,
separación entre lógica e interfaz, política de tests, persistencia de datos
e idioma del código y los mensajes. Máximo 15 líneas. Espera mi aprobación.
```

*Genera el [/docs/constitution.md](./docs/constitution.md)*

*Escribimos el [AGENTS.md](./AGENTS.md) y el [CLAUDE.md](./CLAUDE.md)*

**Especificación:**

```text
NO escribas código en ningún momento. Vamos a redactar la especificación de la
primera funcionalidad de habits-cli. Lee docs/constitution.md.

Idea inicial: una CLI con tres comandos: crear un hábito, marcarlo como hecho
hoy, y listar los hábitos con su racha de días consecutivos.

Tu trabajo:
1. Hazme preguntas de UNA en UNA para eliminar ambigüedades (casos límite,
   comportamiento con errores, qué queda fuera del MVP). Máximo 6 preguntas.
2. Con mis respuestas, genera specs/001-habits-mvp/spec.md con esta estructura:
   contexto y objetivo, usuarios, historias de usuario, requisitos funcionales
   numerados (RF-x) con criterios de aceptación en notación EARS en español,
   requisitos no funcionales, casos límite, fuera de alcance, criterios de
   finalización y dudas abiertas marcadas como [NECESITA ACLARACIÓN].
3. El QUÉ y el POR QUÉ. Nada de stack, arquitectura ni nombres de archivos:
   eso irá en el plan.
```

*Genera el [specs/001-habits-mvp/spec.md](./specs/001-habits-mvp/spec.md)*

**Clarificación:**

```text
Revisa specs/001-habits-mvp/spec.md como si fueras un QA muy profesional.
Lista: (1) ambigüedades restantes, (2) contradicciones entre requisitos,
(3) casos límite no cubiertos, (4) conflictos con docs/constitution.md.
No propongas soluciones todavía: solo detecta. Formato: lista numerada.
```

**Planificación:**

```text
Lee docs/constitution.md y specs/001-habits-mvp/spec.md. NO escribas código.
Genera specs/001-habits-mvp/plan.md con: estructura de módulos, modelo de
datos JSON con un ejemplo, algoritmo de cálculo de racha en pseudocódigo,
contrato de la CLI (comandos, salidas, códigos de salida), decisiones técnicas
justificadas (y su alternativa descartada), y estrategia de tests. Todo debe
respetar la constitución y cubrir todos los RF. Marca qué RF cubre cada parte.
```

*Genera el [specs/001-habits-mvp/plan.md](./specs/001-habits-mvp/plan.md)*

**Tareas:**

```text
A partir de spec.md y plan.md, genera specs/001-habits-mvp/tasks.md:
tareas pequeñas (máx. 20-30 min cada una), en orden de dependencia, cada una
con los RF que cubre y una línea "Hecho cuando:" verificable. Usa checkboxes.
```

*Genera el [specs/001-habits-mvp/tasks.md](./specs/001-habits-mvp/tasks.md)*

**Implementación:**

```text
Implementa SOLO la tarea T2 de specs/001-habits-mvp/tasks.md, siguiendo
plan.md y la constitución. Escribe primero los tests, luego el código.
Ejecuta pytest -q y muéstrame el resultado. Al terminar: marca T2 en tasks.md,
indica qué RF cubre y PÁRATE. No empieces T3.
```

*Genera la implementación del código dentro de /habits*

**Validación**

```text
Recorre specs/001-habits-mvp/spec.md requisito por requisito (RF-1 a RF-11).
Para cada uno indica: qué test lo cubre, y el resultado de ejecutarlo.
Si algún RF no está cubierto o falla, dilo claramente. Después comprueba los
criterios de finalización y dame un veredicto: ¿la spec está cumplida?
```

**Próximos pasos**

```text
Nuevo requisito para habits-cli: marcar como hecho el día de ayer con
`habits done <nombre> --ayer`. NO toques código. Primero: actualiza
specs/001-habits-mvp/spec.md (nuevo RF con EARS + casos límite: ¿y si ayer
ya estaba marcado? ¿afecta a la racha?) y muéstrame el diff de la spec.
```
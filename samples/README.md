# Hello SDD: Curso de Spec-Driven Development (SDD) desde cero

[![Curso de Spec-Driven Development](https://img.youtube.com/vi/5HaOxAAA5qI/maxresdefault.jpg)](https://youtube.com/live/5HaOxAAA5qI)

## Curso de [MoureDev](https://moure.dev) sobre **Spec-Driven Development (SDD)**: desarrollar software con agentes de IA partiendo de una especificación acordada, en lugar de improvisar prompts. 

> **Es indispensable [ver el curso](https://youtube.com/live/5HaOxAAA5qI) para entender el contenido del repositorio.**

Contiene dos cosas: las **plantillas** usadas en el curso (`samples/`) y un **proyecto completo** construido paso a paso con SDD (`habits-cli/`).

```
HelloSDD/
├── samples/            # Plantillas y material del curso
│   ├── AGENTS.md       # Plantilla de instrucciones para el agente
│   ├── spec.md         # Plantilla de especificación (RF en notación EARS)
│   ├── prompts.md      # Prompt esencial de cada fase del flujo SDD
│   └── sdd.excalidraw  # Pizarra del curso (guion por bloques y diagramas)
└── habits-cli/         # Proyecto práctico desarrollado con SDD
```

## `samples/` — plantillas

| Archivo | Qué es |
|---|---|
| `AGENTS.md` | Plantilla del archivo de contexto para el agente: qué es el proyecto, comandos, estilo, reglas y verificación obligatoria al terminar. `CLAUDE.md` puede limitarse a `@AGENTS.md`. |
| `spec.md` | Plantilla de especificación: contexto, usuarios, historias, requisitos funcionales numerados (RF-x) en notación EARS, casos límite, fuera de alcance, criterios de finalización y dudas abiertas. |
| `prompts.md` | Tabla con el prompt esencial de cada fase: constitución, spec, clarificación, plan, tareas, implementación, validación y cambio. |
| `sdd.excalidraw` | Pizarra del curso: el guion por bloques (qué es SDD, vibe coding, tipos de SDD, EARS, flujo de trabajo, práctica…) y diagramas de cómo trabaja un agente. Se abre en [excalidraw.com](https://excalidraw.com). |

## `habits-cli/` — el proyecto con SDD

Una CLI en Python (solo biblioteca estándar) para registrar hábitos de estudio y ver la racha de días consecutivos: `habits add`, `habits done` y `habits list`.

Lo importante no es la app, sino **cómo se construyó**. Cada paso del flujo SDD dejó su artefacto en el repo:

| Paso | Artefacto |
|---|---|
| 1. Constitución | `docs/constitution.md` — 6 principios innegociables del proyecto |
| Contexto del agente | `AGENTS.md` + `CLAUDE.md` |
| 2. Especificación | `specs/001-habits-mvp/spec.md` — RF-1 a RF-11 en notación EARS |
| 3. Clarificación | Revisión de la spec como QA: detecta ambigüedades y huecos antes de planificar |
| 4. Planificación | `specs/001-habits-mvp/plan.md` — módulos, modelo de datos, algoritmo de racha, contrato CLI y decisiones técnicas |
| 5. Tareas | `specs/001-habits-mvp/tasks.md` — T1 a T8 con checkboxes y su "Hecho cuando:" |
| 6. Implementación | `habits/` (core + storage + cli) y `tests/`, una tarea cada vez y tests primero |
| 7. Validación | Recorrido RF por RF comprobando qué test cubre cada uno |

Incluye además una **skill** reutilizable, `spec-generator` (`.claude/skills/spec-generator/`), que guía la entrevista de requisitos y genera la spec siguiendo la plantilla. Está enlazada también para opencode en `.opencode/skill/`.

Los prompts exactos de cada paso, y cómo ejecutar la app y sus tests, están en el [README de habits-cli](./habits-cli/README.md).

## El flujo SDD en una línea

Constitución → Spec → Clarificación → Plan → Tareas → Implementación (una tarea cada vez, tests primero) → Validación → Cambio (primero la spec, luego el código).

## ![https://mouredev.com](https://raw.githubusercontent.com/mouredev/mouredev/master/mouredev_emote.png) Hola, mi nombre es Brais Moure.

[![YouTube Channel Subscribers](https://img.shields.io/youtube/channel/subscribers/UCxPD7bsocoAMq8Dj18kmGyQ?style=social)](https://youtube.com/mouredevapps?sub_confirmation=1)
[![Discord](https://img.shields.io/discord/729672926432985098?style=social&label=Discord&logo=discord)](https://mouredev.com/discord)
![GitHub Followers](https://img.shields.io/github/followers/mouredev?style=social)
![GitHub Followers](https://img.shields.io/github/stars/mouredev?style=social)

Soy ingeniero de software desde 2010. Desde 2018 combino mi trabajo como desarrollador con la creación de contenido formativo y divulgativo sobre programación e IA en diferentes redes sociales como **[@mouredev](https://moure.dev)**.

Si quieres unirte a nuestra comunidad de desarrollo y aprender programación e inteligencia artificial, puedes encontrarme en:

[![Pro](https://img.shields.io/badge/Cursos-mouredev.pro-FF5500?style=for-the-badge&logo=gnometerminal&logoColor=white&labelColor=101010)](https://mouredev.pro)
[![Link](https://img.shields.io/badge/Links_de_interés-moure.dev-14a1f0?style=for-the-badge&logo=Linktree&logoColor=white&labelColor=101010)](https://moure.dev)
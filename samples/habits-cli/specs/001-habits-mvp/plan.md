# Plan técnico — Spec 001

## Estructura de módulos
- habits/storage.py → cargar/guardar JSON (RF-9, RF-11)
- habits/core.py    → lógica pura: add, done, streak, list (RF-1..8, RF-10)
- habits/cli.py     → argparse, mensajes en español, códigos de salida
- habits/__main__.py → permite `python -m habits`
- tests/            → pytest, uno o más tests por RF

## Modelo de datos (habits.json)
{
  "version": 1,
  "habits": [
    { "name": "Estudiar Python",
      "created_at": "2026-08-27",
      "completions": ["2026-08-25", "2026-08-26", "2026-08-27"] }
  ]
}
- Fechas ISO (YYYY-MM-DD), orden ascendente, sin duplicados (RF-5).

## Algoritmo de racha (RF-10)
1. Si no hay completions → 0.
2. last = última fecha. Si last < ayer → 0.
3. Contar hacia atrás desde last mientras las fechas sean consecutivas.

## Decisiones técnicas
- argparse (stdlib) en vez de typer/click → constitución nº 1.
- Comparación de nombres: strip() + casefold(); se conserva el original
  para mostrar (RF-2).
- La fecha "hoy" se INYECTA en el core (parámetro `today: date`), para
  poder testear rachas sin mockear el reloj. La CLI pasa date.today().
- storage nunca escribe si la carga falló → imposible machacar datos (RF-11).

## Contrato CLI
- habits add <nombre> | done <nombre> | list
- stdout para resultados; stderr para errores; salidas 0/1 según spec.

## Estrategia de tests
- Unitarios de core con fechas inyectadas (rachas: vacía, viva por ayer,
  rota, de 1 día, larga).
- storage con tmp_path de pytest (inexistente, válido, corrupto).
- Smoke test de CLI invocando el parser.
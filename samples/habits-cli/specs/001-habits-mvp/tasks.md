# Tareas — Spec 001

- [x] T1. Esqueleto del proyecto: paquete habits/, tests/, pytest configurado.
      (RF: —) Hecho cuando: `pytest -q` corre (0 tests) sin errores.
- [x] T2. storage.py: load/save JSON; inexistente → estructura vacía;
      corrupto → error propio sin sobrescribir. (RF-9, RF-11)
      Hecho cuando: tests de los 3 escenarios en verde.
- [x] T3. core.add_habit con normalización y duplicados. (RF-1, RF-2, RF-3)
      Hecho cuando: tests de crear, duplicado (con mayúsculas) y vacío en verde.
- [x] T4. core.mark_done idempotente con fecha inyectada. (RF-4, RF-5, RF-6)
      Hecho cuando: tests de hecho, repetido e inexistente en verde.
- [x] T5. core.streak con todos los casos límite. (RF-10)
      Hecho cuando: tests de racha 0, viva por ayer, rota, 1 día y larga en verde.
- [x] T6. core.list_habits ordenado + caso vacío. (RF-7, RF-8)
      Hecho cuando: tests de orden y de lista vacía en verde.
- [x] T7. cli.py con argparse: add/done/list, mensajes en español y códigos
      de salida. (RF-1..RF-8) Hecho cuando: smoke tests de CLI en verde.
- [x] T8. Validación final: checklist de la spec + README breve. (Todos)
      Hecho cuando: cada RF tiene test asociado y demo manual OK.
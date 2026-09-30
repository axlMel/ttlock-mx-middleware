"""Lógica de dominio: pura, sin entrada/salida ni reloj propio.

Todas las funciones reciben la fecha de hoy como parámetro (``today``) para
poder probar las rachas sin depender del reloj del sistema.
"""

from __future__ import annotations

from collections.abc import Iterable
from datetime import date, timedelta
from typing import Any

Habit = dict[str, Any]
Data = dict[str, Any]


class HabitError(Exception):
    """Error de dominio; la CLI lo traduce a un mensaje en español."""


class EmptyNameError(HabitError):
    """El nombre está vacío o solo tiene espacios (RF-3)."""


class DuplicateHabitError(HabitError):
    """Ya existe un hábito con ese nombre (RF-2)."""


class HabitNotFoundError(HabitError):
    """No existe ningún hábito con ese nombre (RF-6)."""


def normalize(name: str) -> str:
    """Clave de comparación: sin espacios exteriores y sin mayúsculas (RF-2)."""
    return name.strip().casefold()


def _find(data: Data, name: str) -> Habit | None:
    key = normalize(name)
    for habit in data["habits"]:
        if normalize(habit["name"]) == key:
            return habit
    return None


def add_habit(data: Data, name: str, *, today: date) -> Data:
    """Crea un hábito nuevo (RF-1).

    Lanza ``EmptyNameError`` si el nombre está vacío (RF-3) y
    ``DuplicateHabitError`` si ya existe uno equivalente (RF-2).
    """
    display_name = name.strip()
    if not display_name:
        raise EmptyNameError(name)

    existing = _find(data, display_name)
    if existing is not None:
        raise DuplicateHabitError(existing["name"])

    data["habits"].append(
        {
            "name": display_name,
            "created_at": today.isoformat(),
            "completions": [],
        }
    )
    return data


def mark_done(data: Data, name: str, *, today: date) -> tuple[Data, bool]:
    """Marca el hábito como hecho hoy (RF-4).

    Devuelve los datos y un booleano que indica si ya estaba marcado: la
    operación es idempotente (RF-5). Lanza ``HabitNotFoundError`` si el
    hábito no existe (RF-6).
    """
    habit = _find(data, name)
    if habit is None:
        raise HabitNotFoundError(name.strip())

    stamp = today.isoformat()
    already_done = stamp in habit["completions"]
    if not already_done:
        habit["completions"] = sorted({*habit["completions"], stamp})

    return data, already_done


def streak(completions: Iterable[str], *, today: date) -> int:
    """Días consecutivos completados hasta hoy o ayer (RF-10).

    Si el último registro es anterior a ayer, la racha es 0.
    """
    days = sorted({date.fromisoformat(stamp) for stamp in completions})
    if not days:
        return 0

    last = days[-1]
    if last < today - timedelta(days=1):
        return 0

    count = 1
    expected = last - timedelta(days=1)
    for day in reversed(days[:-1]):
        if day != expected:
            break
        count += 1
        expected -= timedelta(days=1)

    return count


def list_habits(data: Data, *, today: date) -> list[dict[str, Any]]:
    """Hábitos con su racha, por racha descendente y nombre alfabético (RF-7).

    Sin hábitos devuelve una lista vacía; el mensaje de RF-8 es cosa de la CLI.
    """
    rows = [
        {"name": habit["name"], "streak": streak(habit["completions"], today=today)}
        for habit in data["habits"]
    ]
    rows.sort(key=lambda row: (-row["streak"], row["name"].casefold()))
    return rows

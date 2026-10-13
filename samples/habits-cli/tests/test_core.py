"""Tests del núcleo puro (T3-T6 — RF-1..RF-8, RF-10)."""

from datetime import date

import pytest
from habits import core

TODAY = date(2026, 8, 27)


def empty_data() -> dict:
    return {"version": 1, "habits": []}


def data_with(name: str, completions: list[str]) -> dict:
    return {
        "version": 1,
        "habits": [
            {"name": name, "created_at": "2026-08-01", "completions": list(completions)}
        ],
    }


# --- T3: add_habit (RF-1, RF-2, RF-3) ---------------------------------------


def test_add_habit_creates_it_with_creation_date():
    """RF-1: un nombre nuevo y no vacío crea el hábito."""
    data = core.add_habit(empty_data(), "Estudiar Python", today=TODAY)

    assert data["habits"] == [
        {
            "name": "Estudiar Python",
            "created_at": "2026-08-27",
            "completions": [],
        }
    ]


def test_add_habit_keeps_the_original_name_for_display():
    """RF-2: se conserva el nombre tal y como lo escribió el usuario."""
    data = core.add_habit(empty_data(), "  Estudiar Python  ", today=TODAY)

    assert data["habits"][0]["name"] == "Estudiar Python"


def test_add_habit_rejects_duplicate_ignoring_case_and_spaces():
    """RF-2: la comparación ignora mayúsculas y espacios exteriores."""
    data = core.add_habit(empty_data(), "Estudiar Python", today=TODAY)

    with pytest.raises(core.DuplicateHabitError):
        core.add_habit(data, "  estudiar PYTHON  ", today=TODAY)

    assert len(data["habits"]) == 1


@pytest.mark.parametrize("name", ["", "   ", "\t\n"])
def test_add_habit_rejects_empty_names(name):
    """RF-3: nombre vacío o solo espacios se rechaza."""
    with pytest.raises(core.EmptyNameError):
        core.add_habit(empty_data(), name, today=TODAY)


# --- T4: mark_done (RF-4, RF-5, RF-6) ---------------------------------------


def test_mark_done_registers_the_injected_date():
    """RF-4: se registra la fecha de hoy como completada."""
    data, already_done = core.mark_done(data_with("Leer", []), "Leer", today=TODAY)

    assert already_done is False
    assert data["habits"][0]["completions"] == ["2026-08-27"]


def test_mark_done_is_idempotent():
    """RF-5: marcar dos veces el mismo día no duplica el registro."""
    data, _ = core.mark_done(data_with("Leer", []), "Leer", today=TODAY)
    data, already_done = core.mark_done(data, "Leer", today=TODAY)

    assert already_done is True
    assert data["habits"][0]["completions"] == ["2026-08-27"]


def test_mark_done_keeps_completions_sorted():
    """El plan exige fechas ISO en orden ascendente y sin duplicados."""
    data, _ = core.mark_done(
        data_with("Leer", ["2026-08-26", "2026-08-25"]), "Leer", today=TODAY
    )

    assert data["habits"][0]["completions"] == [
        "2026-08-25",
        "2026-08-26",
        "2026-08-27",
    ]


def test_mark_done_finds_the_habit_ignoring_case_and_spaces():
    """RF-2: misma normalización de nombres al marcar."""
    data, _ = core.mark_done(data_with("Estudiar Python", []), "  ESTUDIAR python ",
                             today=TODAY)

    assert data["habits"][0]["completions"] == ["2026-08-27"]


def test_mark_done_on_unknown_habit_raises():
    """RF-6: marcar un hábito inexistente es un error."""
    with pytest.raises(core.HabitNotFoundError):
        core.mark_done(empty_data(), "Nadar", today=TODAY)


# --- T5: streak (RF-10) -----------------------------------------------------


def test_streak_without_completions_is_zero():
    assert core.streak([], today=TODAY) == 0


def test_streak_of_a_single_day_done_today_is_one():
    assert core.streak(["2026-08-27"], today=TODAY) == 1


def test_streak_stays_alive_when_last_completion_was_yesterday():
    """RF-10: hecho ayer pero aún no hoy conserva la racha."""
    assert core.streak(["2026-08-25", "2026-08-26"], today=TODAY) == 2


def test_streak_is_broken_when_last_completion_is_older_than_yesterday():
    """RF-10: último registro anterior a ayer → racha 0."""
    assert core.streak(["2026-08-24", "2026-08-25"], today=TODAY) == 0


def test_long_streak_counts_only_consecutive_days():
    """RF-10: un hueco corta el conteo hacia atrás."""
    completions = [
        "2026-08-01",  # anterior al hueco: no cuenta
        "2026-08-23",
        "2026-08-24",
        "2026-08-25",
        "2026-08-26",
        "2026-08-27",
    ]

    assert core.streak(completions, today=TODAY) == 5


def test_streak_tolerates_unsorted_and_repeated_dates():
    assert core.streak(["2026-08-27", "2026-08-26", "2026-08-27"], today=TODAY) == 2


# --- T6: list_habits (RF-7, RF-8) -------------------------------------------


def test_list_habits_is_empty_when_there_are_no_habits():
    """RF-8: sin hábitos, la lista es vacía (la CLI decide el mensaje)."""
    assert core.list_habits(empty_data(), today=TODAY) == []


def test_list_habits_sorts_by_streak_desc_then_name():
    """RF-7: racha descendente y, a igualdad, nombre alfabético."""
    data = {
        "version": 1,
        "habits": [
            {"name": "Nadar", "created_at": "2026-08-01", "completions": ["2026-08-27"]},
            {"name": "Correr", "created_at": "2026-08-01", "completions": ["2026-08-27"]},
            {
                "name": "Estudiar Python",
                "created_at": "2026-08-01",
                "completions": ["2026-08-26", "2026-08-27"],
            },
            {"name": "Meditar", "created_at": "2026-08-01", "completions": []},
        ],
    }

    assert core.list_habits(data, today=TODAY) == [
        {"name": "Estudiar Python", "streak": 2},
        {"name": "Correr", "streak": 1},
        {"name": "Nadar", "streak": 1},
        {"name": "Meditar", "streak": 0},
    ]


def test_duplicate_error_reports_the_existing_name():
    """RF-2: el conflicto se informa con el nombre ya guardado."""
    data = core.add_habit(empty_data(), "Estudiar Python", today=TODAY)

    with pytest.raises(core.DuplicateHabitError) as error:
        core.add_habit(data, "  estudiar PYTHON  ", today=TODAY)

    assert error.value.args[0] == "Estudiar Python"

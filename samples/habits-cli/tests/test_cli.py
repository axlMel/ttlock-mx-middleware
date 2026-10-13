"""Smoke tests de la CLI (T7 — RF-1..RF-8, RF-11)."""

import json
from datetime import date

import pytest
from habits import cli


@pytest.fixture
def data_file(tmp_path):
    return tmp_path / "habits.json"


def run(argv, path, capsys):
    """Ejecuta la CLI y devuelve (código de salida, stdout, stderr)."""
    code = cli.main(argv, path=path)
    captured = capsys.readouterr()
    return code, captured.out, captured.err


def test_add_creates_the_habit(data_file, capsys):
    """RF-1"""
    code, out, err = run(["add", "Estudiar Python"], data_file, capsys)

    assert code == 0
    assert "Estudiar Python" in out
    assert err == ""
    assert data_file.exists()


def test_add_duplicate_fails(data_file, capsys):
    """RF-2"""
    run(["add", "Estudiar Python"], data_file, capsys)

    code, out, err = run(["add", "  estudiar PYTHON "], data_file, capsys)

    assert code == 1
    assert "Ya existe" in err
    assert out == ""


def test_add_empty_name_fails(data_file, capsys):
    """RF-3"""
    code, _, err = run(["add", "   "], data_file, capsys)

    assert code == 1
    assert "vacío" in err


def test_done_marks_the_habit_today(data_file, capsys):
    """RF-4"""
    run(["add", "Leer"], data_file, capsys)

    code, out, err = run(["done", "Leer"], data_file, capsys)

    assert code == 0
    assert "racha: 1 día" in out
    assert err == ""


def test_done_records_the_real_current_date(data_file, capsys):
    """RF-4: la CLI registra la fecha de HOY, no otra."""
    run(["add", "Leer"], data_file, capsys)

    run(["done", "Leer"], data_file, capsys)

    stored = json.loads(data_file.read_text(encoding="utf-8"))
    assert stored["habits"][0]["completions"] == [date.today().isoformat()]


def test_done_twice_is_idempotent(data_file, capsys):
    """RF-5"""
    run(["add", "Leer"], data_file, capsys)
    run(["done", "Leer"], data_file, capsys)

    code, out, _ = run(["done", "Leer"], data_file, capsys)

    assert code == 0
    assert "ya estaba" in out


def test_done_on_unknown_habit_suggests_list(data_file, capsys):
    """RF-6"""
    code, _, err = run(["done", "Nadar"], data_file, capsys)

    assert code == 1
    assert "habits list" in err


def test_list_shows_habits_ordered_by_streak(data_file, capsys):
    """RF-7"""
    run(["add", "Nadar"], data_file, capsys)
    run(["add", "Leer"], data_file, capsys)
    run(["done", "Nadar"], data_file, capsys)

    code, out, _ = run(["list"], data_file, capsys)

    assert code == 0
    assert out.index("Nadar") < out.index("Leer")
    assert "1 día" in out
    assert "0 días" in out


def test_list_without_habits_invites_to_create_one(data_file, capsys):
    """RF-8"""
    code, out, err = run(["list"], data_file, capsys)

    assert code == 0
    assert "habits add" in out
    assert err == ""


def test_corrupt_file_aborts_without_overwriting(data_file, capsys):
    """RF-11"""
    data_file.write_text("{roto", encoding="utf-8")

    code, out, err = run(["add", "Leer"], data_file, capsys)

    assert code == 1
    assert "corrupto" in err
    assert out == ""
    assert data_file.read_text(encoding="utf-8") == "{roto"


def test_usage_error_exits_with_one(data_file, capsys):
    """Contrato de la CLI: solo códigos de salida 0 y 1."""
    code, _, err = run([], data_file, capsys)

    assert code == 1
    assert err != ""

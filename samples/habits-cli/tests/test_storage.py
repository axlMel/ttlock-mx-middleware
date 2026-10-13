"""Tests de habits.storage (T2 — RF-9, RF-11)."""

import json
from pathlib import Path

import pytest
from habits import storage


def test_load_missing_file_returns_empty_structure(tmp_path):
    """RF-9: si el archivo no existe, se parte de una estructura vacía."""
    data = storage.load(tmp_path / "habits.json")

    assert data == {"version": 1, "habits": []}


def test_save_then_load_roundtrip(tmp_path):
    """RF-9: lo guardado se recupera intacto y el JSON es legible."""
    path = tmp_path / "sub" / "habits.json"
    data = {
        "version": 1,
        "habits": [
            {
                "name": "Estudiar Python",
                "created_at": "2026-08-27",
                "completions": ["2026-08-27"],
            }
        ],
    }

    storage.save(path, data)

    assert storage.load(path) == data
    text = path.read_text(encoding="utf-8")
    assert "Estudiar Python" in text  # sin escapes ilegibles
    assert "\n" in text  # indentado, no una sola línea


def test_load_corrupt_file_raises_and_does_not_overwrite(tmp_path):
    """RF-11: JSON inválido aborta sin tocar el archivo."""
    path = tmp_path / "habits.json"
    original = "{esto no es json"
    path.write_text(original, encoding="utf-8")

    with pytest.raises(storage.StorageError):
        storage.load(path)

    assert path.read_text(encoding="utf-8") == original


def test_load_valid_json_with_wrong_shape_raises(tmp_path):
    """RF-11: JSON válido pero con estructura inesperada también aborta."""
    path = tmp_path / "habits.json"
    path.write_text(json.dumps([1, 2, 3]), encoding="utf-8")

    with pytest.raises(storage.StorageError):
        storage.load(path)


def test_default_path_is_a_single_json_file_inside_the_project():
    """RF-9: un único archivo JSON local, en la raíz del proyecto."""
    path = storage.default_path()

    assert path.name == "habits.json"
    assert path.parent == Path(storage.__file__).resolve().parent.parent
    assert (path.parent / "habits").is_dir()  # es la raíz, junto al paquete

"""Persistencia en un único archivo JSON local (RF-9, RF-11)."""

from __future__ import annotations

import json
import os
from pathlib import Path
from typing import Any

VERSION = 1


class StorageError(Exception):
    """El archivo de datos existe pero no se puede interpretar (RF-11)."""


PROJECT_ROOT = Path(__file__).resolve().parent.parent


def default_path() -> Path:
    """Ruta del único archivo de datos: ``habits.json`` en la raíz del proyecto.

    Se resuelve a partir de la ubicación del paquete, no del directorio de
    trabajo, para que la CLI encuentre siempre los mismos datos se ejecute
    desde donde se ejecute.
    """
    return PROJECT_ROOT / "habits.json"


def empty_data() -> dict[str, Any]:
    """Estructura inicial cuando todavía no hay archivo."""
    return {"version": VERSION, "habits": []}


def load(path: Path) -> dict[str, Any]:
    """Lee el archivo de datos.

    Si no existe, devuelve una estructura vacía (RF-9). Si existe pero no es
    JSON válido o no tiene la forma esperada, lanza ``StorageError`` y no
    escribe nada (RF-11).
    """
    try:
        raw = path.read_text(encoding="utf-8")
    except FileNotFoundError:
        return empty_data()
    except OSError as error:
        raise StorageError(f"No se pudo leer {path}: {error}") from error

    try:
        data = json.loads(raw)
    except json.JSONDecodeError as error:
        raise StorageError(f"{path} no contiene JSON válido: {error}") from error

    if not isinstance(data, dict) or not isinstance(data.get("habits"), list):
        raise StorageError(f"{path} no tiene la estructura esperada.")

    return data


def save(path: Path, data: dict[str, Any]) -> None:
    """Escribe el archivo completo, legible por humanos (RF-9).

    Se escribe primero un temporal y luego se reemplaza, para no dejar el
    archivo a medias si algo falla durante la escritura.
    """
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(path.name + ".tmp")
    text = json.dumps(data, indent=2, ensure_ascii=False) + "\n"

    try:
        temporary.write_text(text, encoding="utf-8")
        os.replace(temporary, path)
    except OSError as error:
        temporary.unlink(missing_ok=True)
        raise StorageError(f"No se pudo escribir {path}: {error}") from error

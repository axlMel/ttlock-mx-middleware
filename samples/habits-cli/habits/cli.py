"""Capa fina de terminal: argparse, mensajes en español y códigos de salida.

Contrato: 0 si todo va bien, 1 ante cualquier error. Los resultados van a
stdout y los errores a stderr.
"""

from __future__ import annotations

import argparse
import sys
from collections.abc import Sequence
from datetime import date
from pathlib import Path

from habits import core, storage

EXIT_OK = 0
EXIT_ERROR = 1


class _Parser(argparse.ArgumentParser):
    """Argparse que respeta el contrato de salidas 0/1."""

    def error(self, message: str) -> None:  # type: ignore[override]
        self.print_usage(sys.stderr)
        print(f"{self.prog}: error: {message}", file=sys.stderr)
        raise SystemExit(EXIT_ERROR)


def _days(count: int) -> str:
    return "1 día" if count == 1 else f"{count} días"


def build_parser() -> argparse.ArgumentParser:
    parser = _Parser(
        prog="habits",
        description="Registra hábitos de estudio y consulta tus rachas.",
    )
    commands = parser.add_subparsers(dest="command", required=True, metavar="comando")

    add = commands.add_parser("add", help="crea un hábito")
    add.add_argument("nombre", help="nombre del hábito")

    done = commands.add_parser("done", help="marca el hábito como hecho hoy")
    done.add_argument("nombre", help="nombre del hábito")

    commands.add_parser("list", help="lista los hábitos con su racha actual")

    return parser


def _cmd_add(data: dict, name: str, today: date) -> tuple[int, bool]:
    try:
        core.add_habit(data, name, today=today)
    except core.EmptyNameError:
        print("El nombre del hábito no puede estar vacío.", file=sys.stderr)
        return EXIT_ERROR, False
    except core.DuplicateHabitError as error:
        print(f'Ya existe un hábito llamado "{error.args[0]}".', file=sys.stderr)
        return EXIT_ERROR, False

    print(f'Hábito creado: "{name.strip()}".')
    return EXIT_OK, True


def _cmd_done(data: dict, name: str, today: date) -> tuple[int, bool]:
    try:
        _, already_done = core.mark_done(data, name, today=today)
    except core.HabitNotFoundError as error:
        print(
            f'No existe ningún hábito llamado "{error.args[0]}". '
            "Consulta tus hábitos con: habits list",
            file=sys.stderr,
        )
        return EXIT_ERROR, False

    habit = next(
        habit
        for habit in data["habits"]
        if core.normalize(habit["name"]) == core.normalize(name)
    )
    current = core.streak(habit["completions"], today=today)

    if already_done:
        print(f'"{habit["name"]}" ya estaba hecho hoy (racha: {_days(current)}).')
    else:
        print(f'¡Hecho! "{habit["name"]}" completado hoy (racha: {_days(current)}).')
    return EXIT_OK, not already_done


def _cmd_list(data: dict, today: date) -> tuple[int, bool]:
    rows = core.list_habits(data, today=today)
    if not rows:
        print('Todavía no tienes hábitos. Crea el primero con: habits add "nombre"')
        return EXIT_OK, False

    width = max(len(row["name"]) for row in rows)
    for row in rows:
        print(f'{row["name"]:<{width}}  racha: {_days(row["streak"])}')
    return EXIT_OK, False


def main(argv: Sequence[str] | None = None, *, path: Path | None = None) -> int:
    """Punto de entrada de la CLI. Devuelve el código de salida."""
    parser = build_parser()
    try:
        args = parser.parse_args(argv)
    except SystemExit as exit_signal:
        return int(exit_signal.code or EXIT_OK)

    data_path = path if path is not None else storage.default_path()
    today = date.today()

    try:
        data = storage.load(data_path)
    except storage.StorageError:
        print(
            f"El archivo de datos está corrupto: {data_path}\n"
            "No se ha modificado nada. Revísalo o bórralo para empezar de cero.",
            file=sys.stderr,
        )
        return EXIT_ERROR

    if args.command == "add":
        code, changed = _cmd_add(data, args.nombre, today)
    elif args.command == "done":
        code, changed = _cmd_done(data, args.nombre, today)
    else:
        code, changed = _cmd_list(data, today)

    if changed:
        try:
            storage.save(data_path, data)
        except storage.StorageError as error:
            print(f"No se pudieron guardar los cambios: {error}", file=sys.stderr)
            return EXIT_ERROR

    return code

"""Schema contract coverage for the loop-item start time migration."""

import importlib.util
from pathlib import Path
from types import ModuleType

from pytest import MonkeyPatch
from sqlalchemy import Column


def _load_migration() -> ModuleType:
    path = (
        Path(__file__).parents[2]
        / "alembic"
        / "versions"
        / "20261010_f3a7c9e1b2d4_add_loop_item_start_at.py"
    )
    spec = importlib.util.spec_from_file_location("loop_item_start_at_migration", path)
    assert spec is not None
    assert spec.loader is not None
    migration = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(migration)
    return migration


def test_start_at_matches_the_due_at_non_null_sentinel_contract(
    monkeypatch: MonkeyPatch,
) -> None:
    migration = _load_migration()
    added_columns: list[tuple[str, Column[object]]] = []
    monkeypatch.setattr(
        migration.op,
        "add_column",
        lambda table_name, column: added_columns.append((table_name, column)),
    )

    migration.upgrade()

    table_name, column = added_columns[0]
    assert table_name == "loop_items"
    assert column.name == "start_at"
    assert column.nullable is False
    assert str(column.server_default.arg) == "'1970-01-01 00:00:01'"
    assert column.comment == "开始时间，纪元时间表示未设置"

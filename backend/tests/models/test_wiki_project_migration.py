# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Regression tests for the code-wiki project binding migration."""

import importlib.util
from pathlib import Path
from types import ModuleType
from unittest.mock import Mock

import pytest
from pytest import MonkeyPatch


def _load_migration() -> ModuleType:
    path = (
        Path(__file__).parents[2]
        / "alembic"
        / "versions"
        / "20260804_730e43eb7d0f_bind_wiki_projects_to_their_code_wiki.py"
    )
    spec = importlib.util.spec_from_file_location("wiki_project_migration", path)
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def _migration_with_legacy_constraint(
    monkeypatch: MonkeyPatch, constraint_name: str
) -> tuple[ModuleType, Mock]:
    migration = _load_migration()
    op = Mock()
    inspector = Mock()
    inspector.get_unique_constraints.return_value = [
        {"name": constraint_name, "column_names": ["source_url"]}
    ]
    op.get_bind.return_value = Mock()
    monkeypatch.setattr(migration, "op", op)
    monkeypatch.setattr(migration.sa, "inspect", lambda _: inspector)
    return migration, op


@pytest.mark.parametrize("constraint_name", ["source_url", "uniq_source_url"])
def test_upgrade_drops_whichever_legacy_source_url_constraint_exists(
    monkeypatch: MonkeyPatch, constraint_name: str
) -> None:
    migration, op = _migration_with_legacy_constraint(monkeypatch, constraint_name)

    migration.upgrade()

    op.drop_constraint.assert_called_once_with(
        constraint_name, "wiki_projects", type_="unique"
    )


def test_upgrade_refuses_an_unknown_legacy_schema_before_changing_it(
    monkeypatch: MonkeyPatch,
) -> None:
    migration = _load_migration()
    op = Mock()
    inspector = Mock()
    inspector.get_unique_constraints.return_value = []
    op.get_bind.return_value = Mock()
    monkeypatch.setattr(migration, "op", op)
    monkeypatch.setattr(migration.sa, "inspect", lambda _: inspector)

    with pytest.raises(RuntimeError, match="source_url unique constraint"):
        migration.upgrade()

    op.add_column.assert_not_called()

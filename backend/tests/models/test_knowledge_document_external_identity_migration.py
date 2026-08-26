# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Regression tests for the knowledge document external identity migration."""

import importlib.util
from pathlib import Path
from types import ModuleType
from unittest.mock import Mock

from pytest import MonkeyPatch


def _load_migration() -> ModuleType:
    path = (
        Path(__file__).parents[2]
        / "alembic"
        / "versions"
        / "20260826_c5d6e7f8a9b0_add_knowledge_document_external_identity.py"
    )
    spec = importlib.util.spec_from_file_location("external_identity_migration", path)
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def _migration_with_mock_op(monkeypatch: MonkeyPatch) -> tuple[ModuleType, Mock]:
    migration = _load_migration()
    op = Mock()
    monkeypatch.setattr(migration, "op", op)
    return migration, op


def test_upgrade_adds_identity_columns_and_unique_index(
    monkeypatch: MonkeyPatch,
) -> None:
    migration, op = _migration_with_mock_op(monkeypatch)

    migration.upgrade()

    added_columns = [call.args[1].name for call in op.add_column.call_args_list]
    assert added_columns == ["external_provider", "external_resource_id"]
    op.create_index.assert_called_once_with(
        "uq_knowledge_documents_external",
        "knowledge_documents",
        ["kind_id", "external_provider", "external_resource_id"],
        unique=True,
    )


def test_downgrade_reverses_upgrade(monkeypatch: MonkeyPatch) -> None:
    migration, op = _migration_with_mock_op(monkeypatch)

    migration.downgrade()

    op.drop_index.assert_called_once_with(
        "uq_knowledge_documents_external", table_name="knowledge_documents"
    )
    dropped_columns = [call.args[1] for call in op.drop_column.call_args_list]
    assert dropped_columns == ["external_resource_id", "external_provider"]

# SPDX-FileCopyrightText: 2026 Weibo, Inc.
# SPDX-License-Identifier: Apache-2.0

"""Contracts for the no-new-table execution truth migration."""

import importlib.util
from pathlib import Path
from types import ModuleType
from unittest.mock import MagicMock

import pytest

pytestmark = pytest.mark.unit


def _load_migration() -> ModuleType:
    path = (
        Path(__file__).parents[2]
        / "alembic"
        / "versions"
        / "20260815_d9e0f1a2b3c4_add_execution_truth_columns.py"
    )
    spec = importlib.util.spec_from_file_location("execution_truth_migration", path)
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def test_upgrade_extends_only_the_existing_execution_table() -> None:
    migration = _load_migration()
    operation = MagicMock()
    operation.get_bind.return_value.dialect.name = "mysql"
    migration.op = operation

    migration.upgrade()

    assert migration.down_revision == "c8d9e0f1a2b3"
    operation.create_table.assert_not_called()
    assert {call.args[0] for call in operation.add_column.call_args_list} == {
        "loop_item_executions"
    }
    assert [call.args[1].name for call in operation.add_column.call_args_list] == [
        "attempt_no",
        "previous_execution_id",
        "execution_scope",
        "observed_state",
        "sync_state",
        "claimed_at",
        "start_requested_at",
        "observed_at",
        "cancel_requested_at",
        "last_event_seq",
        "termination_reason",
    ]
    statements = [str(call.args[0]) for call in operation.execute.call_args_list]
    assert any("CONCAT('project_robot:', loop_item_id)" in sql for sql in statements)
    assert any(
        "attempt_no = COALESCE(retry_attempt, 0) + 1" in sql for sql in statements
    )
    operation.create_index.assert_called_once_with(
        "idx_exec_scope_status",
        "loop_item_executions",
        ["execution_scope", "status"],
        unique=False,
    )


def test_downgrade_drops_only_added_columns_and_index() -> None:
    migration = _load_migration()
    operation = MagicMock()
    migration.op = operation

    migration.downgrade()

    operation.create_table.assert_not_called()
    operation.drop_table.assert_not_called()
    operation.drop_index.assert_called_once_with(
        "idx_exec_scope_status", table_name="loop_item_executions"
    )
    assert all(
        call.args[0] == "loop_item_executions"
        for call in operation.drop_column.call_args_list
    )

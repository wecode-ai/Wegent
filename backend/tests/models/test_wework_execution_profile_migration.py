# SPDX-FileCopyrightText: 2026 Weibo, Inc.
# SPDX-License-Identifier: Apache-2.0

"""Contracts for the minimal Wework execution identity migration."""

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
        / "20260813_c8d9e0f1a2b3_generalize_wework_execution_profiles.py"
    )
    spec = importlib.util.spec_from_file_location("wework_execution_migration", path)
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def test_upgrade_only_adds_minimal_execution_identity() -> None:
    migration = _load_migration()
    operation = MagicMock()
    migration.op = operation

    migration.upgrade()

    assert migration.down_revision == "d9e0f1a2b3c4"
    added_columns = [call.args[1].name for call in operation.add_column.call_args_list]
    assert added_columns == [
        "executor_type",
        "executor_owner_user_id",
        "automation_run_id",
    ]
    statements = [call.args[0] for call in operation.execute.call_args_list]
    assert len(statements) == 3
    assert "created_by_user_id" in statements[0]
    assert "'$.executor_type'" in statements[1]
    assert "'project_robot'" in statements[1]
    assert "COALESCE(assignee_agent_id, '') <> ''" in statements[1]
    assert (
        "JSON_UNQUOTE(JSON_EXTRACT(metadata, '$.executor_type')) IS NULL"
        in statements[1]
    )
    assert "status = 'disabled'" in statements[2]
    assert "migration_error" in statements[2]
    assert "deleted_at =" not in statements[2]
    assert all("status = 'cancelled'" not in statement for statement in statements)
    operation.drop_column.assert_not_called()
    operation.create_index.assert_called_once_with(
        "uniq_exec_automation_run_id",
        "loop_item_executions",
        ["automation_run_id"],
        unique=True,
    )


def test_downgrade_restores_required_agent_without_changing_run_state() -> None:
    migration = _load_migration()
    operation = MagicMock()
    migration.op = operation

    migration.downgrade()

    statements = [call.args[0] for call in operation.execute.call_args_list]
    assert statements == [
        "UPDATE loop_item_executions SET agent_id = '' WHERE agent_id IS NULL"
    ]
    assert all("status" not in statement for statement in statements)
    dropped_columns = [call.args[1] for call in operation.drop_column.call_args_list]
    assert dropped_columns == [
        "automation_run_id",
        "executor_owner_user_id",
        "executor_type",
    ]
    operation.add_column.assert_not_called()

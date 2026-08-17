# SPDX-FileCopyrightText: 2026 Weibo, Inc.
# SPDX-License-Identifier: Apache-2.0

"""Contracts for optional identifiers on board execution rows."""

import importlib.util
from pathlib import Path
from types import ModuleType
from unittest.mock import MagicMock

import pytest

from app.models.loop_item_execution import (
    LoopItemExecution,
    _adapt_optional_execution_ids,
)
from app.schemas.project_chat import LoopItemExecutionView

pytestmark = pytest.mark.unit


def _load_migration() -> ModuleType:
    path = (
        Path(__file__).parents[2]
        / "alembic"
        / "versions"
        / "20260817_a3b4c5d6e7f8_restore_execution_sentinel_contract.py"
    )
    spec = importlib.util.spec_from_file_location("execution_sentinel_migration", path)
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def test_execution_optional_ids_use_zero_only_in_storage() -> None:
    execution = LoopItemExecution(team_id=None, backend_task_id=None)

    _adapt_optional_execution_ids(None, None, execution)

    assert execution.team_id == 0
    assert execution.backend_task_id == 0
    assert execution.optional_team_id is None
    assert execution.optional_backend_task_id is None


def test_execution_table_preserves_the_not_null_storage_contract() -> None:
    nullable_columns = [
        column.name for column in LoopItemExecution.__table__.columns if column.nullable
    ]

    assert nullable_columns == []


def test_execution_optional_ids_preserve_real_identifiers() -> None:
    execution = LoopItemExecution(team_id=42, backend_task_id=84)

    _adapt_optional_execution_ids(None, None, execution)

    assert execution.optional_team_id == 42
    assert execution.optional_backend_task_id == 84


def test_execution_view_normalizes_zero_sentinels() -> None:
    values = {
        "id": 1,
        "loop_item_id": "TASK-1",
        "cloud_project_id": "project-1",
        "task_title": "Task",
        "task_status": "todo",
        "task_priority": "medium",
        "team_id": 0,
        "backend_task_id": 0,
        "assigner_user_id": 7,
        "execution_environment": "local",
        "execution_device_id": "local-device",
        "status": "queued",
        "display_state": "queued",
        "priority_weight": 20,
        "created_at": "2026-08-17T10:00:00",
        "updated_at": "2026-08-17T10:00:00",
    }

    view = LoopItemExecutionView.model_validate(values)

    assert view.team_id is None
    assert view.backend_task_id is None


def test_upgrade_restores_not_null_sentinel_contract() -> None:
    migration = _load_migration()
    operation = MagicMock()
    inspector = MagicMock()
    inspector.get_foreign_keys.side_effect = lambda table: (
        [
            {
                "name": "fk_loop_items_assignee_team_id_kinds",
                "constrained_columns": ["assignee_team_id"],
            }
        ]
        if table == "loop_items"
        else [
            {
                "name": "fk_loop_item_executions_team_id_kinds",
                "constrained_columns": ["team_id"],
            },
            {
                "name": "fk_loop_item_executions_backend_task_id_tasks",
                "constrained_columns": ["backend_task_id"],
            },
        ]
    )
    migration.op = operation
    migration.sa.inspect = MagicMock(return_value=inspector)

    migration.upgrade()

    assert migration.down_revision == "f1a2b3c4d5e6"
    assert operation.drop_constraint.call_count == 3
    assert operation.execute.call_count == 3
    assert operation.alter_column.call_count == 3
    assert all(
        call.kwargs["nullable"] is False and call.kwargs["server_default"] == "0"
        for call in operation.alter_column.call_args_list
    )


def test_downgrade_restores_nullable_foreign_keys() -> None:
    migration = _load_migration()
    operation = MagicMock()
    migration.op = operation

    migration.downgrade()

    assert operation.alter_column.call_count == 3
    assert all(
        call.kwargs["nullable"] is True and call.kwargs["server_default"] is None
        for call in operation.alter_column.call_args_list
    )
    assert operation.execute.call_count == 3
    assert operation.create_foreign_key.call_count == 3

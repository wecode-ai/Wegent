# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Schema checks for task/subtask BIGINT identifiers."""

import importlib.util
from pathlib import Path

import pytest
import sqlalchemy as sa

from app.models.resource_member import ResourceMember
from app.models.share_link import ShareLink
from app.models.subscription import BackgroundExecution
from app.models.task import TaskResource
from app.models.wiki import WikiGeneration
from shared.models.db.subtask import Subtask
from shared.models.db.subtask_context import SubtaskContext
from shared.models.db.work_queue import QueueMessage

pytestmark = pytest.mark.unit


BIGINT_COLUMNS = [
    (TaskResource, "id"),
    (Subtask, "id"),
    (Subtask, "task_id"),
    (Subtask, "parent_id"),
    (Subtask, "reply_to_subtask_id"),
    (SubtaskContext, "subtask_id"),
    (ResourceMember, "resource_id"),
    (ResourceMember, "copied_resource_id"),
    (ShareLink, "resource_id"),
    (BackgroundExecution, "task_id"),
    (WikiGeneration, "task_id"),
    (QueueMessage, "source_task_id"),
    (QueueMessage, "process_task_id"),
]


@pytest.mark.parametrize(("model", "column_name"), BIGINT_COLUMNS)
def test_task_related_id_columns_are_bigint(model, column_name: str) -> None:
    column = model.__table__.c[column_name]

    assert isinstance(column.type, sa.BigInteger)


@pytest.mark.parametrize("model", [TaskResource, Subtask])
def test_single_table_primary_ids_keep_autoincrement(model) -> None:
    column = model.__table__.c.id

    assert column.autoincrement is True


def test_task_bigint_migration_targets_expected_columns() -> None:
    migration_path = (
        Path(__file__).resolve().parents[2]
        / "alembic"
        / "versions"
        / "20260612_d5e6f7a8b9c0_add_task_subtask_bigint_ids.py"
    )
    assert migration_path.exists()

    spec = importlib.util.spec_from_file_location(
        "task_bigint_migration", migration_path
    )
    assert spec and spec.loader
    migration = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(migration)

    assert migration.down_revision == "c4d5e6f7a8b9"
    assert migration.TASK_ID_COLUMNS[0] == (
        "tasks",
        "id",
        False,
        "Primary key",
        None,
        True,
    )
    assert migration.SUBTASK_ID_COLUMNS[0] == (
        "subtasks",
        "id",
        False,
        None,
        None,
        True,
    )
    assert not hasattr(migration, "TASK_SHARD_TABLES")
    assert not hasattr(migration, "SUBTASK_SHARD_TABLES")
